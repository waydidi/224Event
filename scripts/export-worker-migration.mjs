import { writeFile } from "node:fs/promises";
const guardTables = [
  "staff",
  "tables",
  "table_sessions",
  "session_access",
  "menu_categories",
  "menu_items",
  "orders",
  "order_items",
  "bills",
  "bill_lines",
  "payments",
  "receipts",
  "callback_actions",
  "counters",
];
const triggers = guardTables
  .flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (event) =>
        `CREATE TRIGGER revision_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE app_revision SET revision=revision+1 WHERE id=1; END;`,
    ),
  )
  .join("\n");
await writeFile(
  "migrations/0032_worker_runtime.sql",
  `-- Runtime coordination and durable Worker storage. No business data reset.
CREATE TABLE app_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO app_revision VALUES (1,0);
CREATE TABLE worker_leases (name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE telegram_inbox (update_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, processed_at TEXT, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT NOT NULL);
CREATE INDEX telegram_inbox_pending ON telegram_inbox(next_retry_at) WHERE processed_at IS NULL;
CREATE TABLE receipt_pdfs (receipt_id INTEGER PRIMARY KEY REFERENCES receipts(id), pdf BLOB NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
${triggers}
`,
);
