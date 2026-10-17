export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const schema = /* sql */ `
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE staff (
  id               INTEGER PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('server', 'cashier', 'lead')),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at       TEXT NOT NULL
);

CREATE TABLE tables (
  id                 INTEGER PRIMARY KEY,
  display_number     INTEGER NOT NULL UNIQUE CHECK (display_number > 0),
  name               TEXT,
  permanent_qr_token TEXT NOT NULL UNIQUE,
  current_session_id INTEGER REFERENCES table_sessions(id),
  status             TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'OCCUPIED')),
  created_at         TEXT NOT NULL
);

CREATE TABLE table_sessions (
  id                  INTEGER PRIMARY KEY,
  table_id            INTEGER NOT NULL REFERENCES tables(id),
  round_number        INTEGER NOT NULL CHECK (round_number > 0),
  session_code        TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('OPEN', 'PAYMENT_REQUESTED', 'PAID_CLOSED', 'VOIDED')),
  join_pin            TEXT NOT NULL,
  pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
  opened_at           TEXT NOT NULL,
  opened_by           INTEGER REFERENCES staff(id),
  closed_at           TEXT,
  bill_version        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (table_id, round_number)
);
-- Only one active (non-closed) session per physical table.
CREATE UNIQUE INDEX one_active_session_per_table
  ON table_sessions(table_id) WHERE status IN ('OPEN', 'PAYMENT_REQUESTED');

CREATE TABLE session_access (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES table_sessions(id),
  hashed_visit_token TEXT NOT NULL UNIQUE,
  issued_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT
);
CREATE INDEX session_access_session ON session_access(session_id);

CREATE TABLE menu_categories (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE menu_items (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES menu_categories(id),
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  price_satang INTEGER CHECK (price_satang IS NULL OR price_satang > 0),
  image_url    TEXT,
  available    INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  prep_note    TEXT,
  sort_order   INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE orders (
  id              INTEGER PRIMARY KEY,
  order_number    TEXT NOT NULL UNIQUE,
  session_id      INTEGER NOT NULL REFERENCES table_sessions(id),
  status          TEXT NOT NULL CHECK (status IN ('NEW', 'SERVED')),
  notes           TEXT,
  total_satang    INTEGER NOT NULL CHECK (total_satang > 0),
  created_at      TEXT NOT NULL,
  served_at       TEXT,
  served_by       INTEGER REFERENCES staff(id),
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  serve_action_id TEXT,
  UNIQUE (session_id, idempotency_key)
);
CREATE INDEX orders_session ON orders(session_id);

CREATE TABLE order_items (
  id                 INTEGER PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id       INTEGER NOT NULL REFERENCES menu_items(id),
  item_name_snapshot TEXT NOT NULL,
  unit_price_satang  INTEGER NOT NULL CHECK (unit_price_satang > 0),
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  line_total_satang  INTEGER NOT NULL,
  CHECK (line_total_satang = unit_price_satang * quantity)
);
CREATE INDEX order_items_order ON order_items(order_id);

-- Orders and their lines are immutable once accepted.
CREATE TRIGGER order_items_immutable_update BEFORE UPDATE ON order_items
BEGIN SELECT RAISE(ABORT, 'order_items are immutable'); END;
CREATE TRIGGER order_items_immutable_delete BEFORE DELETE ON order_items
BEGIN SELECT RAISE(ABORT, 'order_items are immutable'); END;
CREATE TRIGGER orders_immutable_fields BEFORE UPDATE OF session_id, total_satang, notes, order_number, created_at ON orders
BEGIN SELECT RAISE(ABORT, 'order financial fields are immutable'); END;

CREATE TABLE bills (
  id                 INTEGER PRIMARY KEY,
  bill_number        TEXT NOT NULL UNIQUE,
  session_id         INTEGER NOT NULL REFERENCES table_sessions(id),
  version            INTEGER NOT NULL,
  subtotal_satang    INTEGER NOT NULL,
  adjustments_satang INTEGER NOT NULL DEFAULT 0,
  adjustments_json   TEXT NOT NULL DEFAULT '[]',
  total_satang       INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('REQUESTED', 'PAID', 'CANCELLED')),
  requested_at       TEXT NOT NULL,
  cancelled_at       TEXT,
  cancelled_by       INTEGER REFERENCES staff(id),
  paid_at            TEXT,
  UNIQUE (session_id, version),
  CHECK (total_satang = subtotal_satang + adjustments_satang)
);
CREATE UNIQUE INDEX one_requested_bill_per_session ON bills(session_id) WHERE status = 'REQUESTED';

CREATE TABLE bill_lines (
  id                INTEGER PRIMARY KEY,
  bill_id           INTEGER NOT NULL REFERENCES bills(id),
  order_id          INTEGER NOT NULL REFERENCES orders(id),
  order_number      TEXT NOT NULL,
  item_name         TEXT NOT NULL,
  unit_price_satang INTEGER NOT NULL,
  quantity          INTEGER NOT NULL,
  line_total_satang INTEGER NOT NULL
);
CREATE INDEX bill_lines_bill ON bill_lines(bill_id);

CREATE TABLE payments (
  id              INTEGER PRIMARY KEY,
  bill_id         INTEGER NOT NULL REFERENCES bills(id),
  amount_satang   INTEGER NOT NULL CHECK (amount_satang > 0),
  method          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('CONFIRMED')),
  confirmed_by    INTEGER NOT NULL REFERENCES staff(id),
  confirmed_at    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
-- One successful final payment per bill (no split payments in v1).
CREATE UNIQUE INDEX one_payment_per_bill ON payments(bill_id) WHERE status = 'CONFIRMED';
CREATE TRIGGER payments_immutable BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;

CREATE TABLE receipts (
  id                  INTEGER PRIMARY KEY,
  payment_id          INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  receipt_number      TEXT NOT NULL UNIQUE,
  lookup_token        TEXT NOT NULL UNIQUE,
  width_mm            INTEGER NOT NULL,
  pdf_storage_key     TEXT,
  generated_at        TEXT,
  generation_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE callback_actions (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE telegram_messages (
  id              INTEGER PRIMARY KEY,
  event_type      TEXT NOT NULL,
  entity_id       INTEGER NOT NULL,
  chat_id         TEXT NOT NULL,
  message_id      INTEGER,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED')),
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (event_type, entity_id)
);

CREATE TABLE telegram_updates (
  update_id   INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id          INTEGER PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system', 'unknown')),
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  timestamp   TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_entity ON audit_events(entity_type, entity_id);
CREATE TRIGGER audit_append_only_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are append-only'); END;
CREATE TRIGGER audit_append_only_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are append-only'); END;

CREATE TABLE outbox_events (
  id            INTEGER PRIMARY KEY,
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  dedupe_key    TEXT UNIQUE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  delivered_at  TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX outbox_pending ON outbox_events(next_retry_at) WHERE delivered_at IS NULL;
`;

interface SeedItem {
  code: string;
  name: string;
}

const signature: SeedItem[] = [
  { code: 'lost-cherry', name: 'Lost Cherry' },
  { code: '224-fireball', name: '224 Fireball' },
  { code: 'mango-sticky-rice', name: 'Mango Sticky Rice' },
  { code: 'the-basket-case', name: 'The Basket Case' },
  { code: 'naoko', name: 'Naoko' },
  { code: 'the-morning-light', name: 'The Morning Light' },
];

const classic: SeedItem[] = [
  { code: 'negroni', name: 'Negroni' },
  { code: 'old-fashioned', name: 'Old Fashioned' },
  { code: 'cosmopolitan', name: 'Cosmopolitan' },
  { code: 'espresso-martini', name: 'Espresso Martini' },
  { code: 'margarita', name: 'Margarita' },
  { code: 'mojito', name: 'Mojito' },
  { code: 'daiquiri', name: 'Daiquiri' },
  { code: 'whiskey-sour', name: 'Whiskey Sour' },
  { code: 'martini', name: 'Martini' },
  { code: 'long-island-iced-tea', name: 'Long Island Iced Tea' },
  { code: 'manhattan', name: 'Manhattan' },
  { code: 'gin-fizz', name: 'Gin Fizz' },
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Prices are intentionally NULL: they are not yet approved. Ordering is blocked
// until every item has a configured price (see `npm run admin -- set-price`).
const seedMenu = [
  `INSERT INTO menu_categories(id, code, name, sort_order) VALUES (1, 'signature', 'Signature Cocktails', 1), (2, 'classic', 'Classic Cocktails', 2);`,
  ...signature.map(
    (it, i) =>
      `INSERT INTO menu_items(category_id, code, name, price_satang, available, sort_order, updated_at) VALUES (1, ${q(it.code)}, ${q(it.name)}, NULL, 1, ${i + 1}, '1970-01-01T00:00:00.000Z');`,
  ),
  ...classic.map(
    (it, i) =>
      `INSERT INTO menu_items(category_id, code, name, price_satang, available, sort_order, updated_at) VALUES (2, ${q(it.code)}, ${q(it.name)}, NULL, 1, ${i + 1}, '1970-01-01T00:00:00.000Z');`,
  ),
].join('\n');

// Classic recipes use the standard IBA-style ingredients; signature cocktails
// are left empty until the bar provides their recipes (item:update --ingredients).
const ingredients = `
ALTER TABLE menu_items ADD COLUMN ingredients TEXT NOT NULL DEFAULT '[]';
UPDATE menu_items SET ingredients = '["Gin", "Campari", "Sweet vermouth", "Orange peel"]' WHERE code = 'negroni';
UPDATE menu_items SET ingredients = '["Bourbon whiskey", "Sugar", "Angostura bitters", "Orange peel"]' WHERE code = 'old-fashioned';
UPDATE menu_items SET ingredients = '["Citrus vodka", "Triple sec", "Cranberry juice", "Lime juice"]' WHERE code = 'cosmopolitan';
UPDATE menu_items SET ingredients = '["Vodka", "Coffee liqueur", "Espresso", "Sugar syrup"]' WHERE code = 'espresso-martini';
UPDATE menu_items SET ingredients = '["Tequila", "Triple sec", "Lime juice", "Salt rim"]' WHERE code = 'margarita';
UPDATE menu_items SET ingredients = '["White rum", "Lime", "Mint", "Sugar", "Soda water"]' WHERE code = 'mojito';
UPDATE menu_items SET ingredients = '["White rum", "Lime juice", "Sugar syrup"]' WHERE code = 'daiquiri';
UPDATE menu_items SET ingredients = '["Bourbon whiskey", "Lemon juice", "Sugar syrup", "Egg white", "Angostura bitters"]' WHERE code = 'whiskey-sour';
UPDATE menu_items SET ingredients = '["Gin", "Dry vermouth", "Olive"]' WHERE code = 'martini';
UPDATE menu_items SET ingredients = '["Vodka", "Gin", "White rum", "Tequila", "Triple sec", "Lemon juice", "Cola"]' WHERE code = 'long-island-iced-tea';
UPDATE menu_items SET ingredients = '["Rye whiskey", "Sweet vermouth", "Angostura bitters", "Cherry"]' WHERE code = 'manhattan';
UPDATE menu_items SET ingredients = '["Gin", "Lemon juice", "Sugar syrup", "Soda water"]' WHERE code = 'gin-fizz';
`;

// Event-specific category. Prices are NULL until approved, like the rest of the menu.
const kensBirthday = `
INSERT INTO menu_categories(id, code, name, sort_order) VALUES (3, 'kens-birthday', 'Ken’s birthday Special', 3);
INSERT INTO menu_items(category_id, code, name, price_satang, available, sort_order, updated_at) VALUES
  (3, 'ken-224', '224', NULL, 1, 1, '1970-01-01T00:00:00.000Z'),
  (3, 'ken-33', '33', NULL, 1, 2, '1970-01-01T00:00:00.000Z'),
  (3, 'ken-infinity', 'Infinity', NULL, 1, 3, '1970-01-01T00:00:00.000Z');
`;

// Photos: image_url is the large detail-page picture, thumb_url the small menu-card crop.
const menuPhotos = `
ALTER TABLE menu_items ADD COLUMN thumb_url TEXT;
UPDATE menu_items SET image_url = '/static/menu/the-morning-light.webp', thumb_url = '/static/menu/the-morning-light-thumb.webp'
  WHERE code = 'the-morning-light';
`;

// The Morning Light: story and ingredient names from the bar's menu notes.
// Quantities, method and garnish are deliberately not shown to guests.
const morningLightStory =
  '“The Morning Light” is a homage to Hiroshi Senju and the Japanese philosophy that beauty is revealed through harmony rather than control. ' +
  'Inspired by the painting Morning Light at Hōki-ji Temple, it follows the same path as the artist himself, who fell in love with Suntory whisky for its quiet elegance and natural character. ' +
  'Bright citrus greets the palate like the first rays of dawn, while honey, chrysanthemum, and Japanese whisky settle into a warm, contemplative finish. ' +
  'A drink that captures the first light over a quiet temple, peaceful, luminous, and deeply rooted in nature.';
const morningLightIngredients = ['Suntory Kakubin Whiskey', 'Chrysanthemum liqueur', 'Cointreau', 'Wild honey', 'Lemon juice', 'Angostura bitters', 'Sea salt'];
const morningLightDetails = `
UPDATE menu_items SET description = ${q(morningLightStory)}, ingredients = ${q(JSON.stringify(morningLightIngredients))}
  WHERE code = 'the-morning-light';
`;

// Per-drink note to staff ("less ice"); orders keep their own whole-order note too.
const itemNotes = `ALTER TABLE order_items ADD COLUMN note TEXT NOT NULL DEFAULT '';`;

export const migrations: Migration[] = [
  { version: 1, name: 'schema', sql: schema },
  { version: 2, name: 'seed_menu', sql: seedMenu },
  { version: 3, name: 'menu_ingredients', sql: ingredients },
  { version: 4, name: 'kens_birthday_special', sql: kensBirthday },
  {
    version: 5,
    name: 'category_order',
    sql: `UPDATE menu_categories SET sort_order = CASE code WHEN 'kens-birthday' THEN 1 WHEN 'signature' THEN 2 WHEN 'classic' THEN 3 ELSE sort_order END;`,
  },
  { version: 6, name: 'menu_photos', sql: menuPhotos },
  { version: 7, name: 'morning_light_details', sql: morningLightDetails },
  { version: 8, name: 'order_item_notes', sql: itemNotes },
];
