-- Generated from src/db/migrations.ts. Do not edit directly.
INSERT INTO menu_categories(id, code, name, sort_order) VALUES (3, 'kens-birthday', 'Ken’s birthday Special', 3);
INSERT INTO menu_items(category_id, code, name, price_satang, available, sort_order, updated_at) VALUES
  (3, 'ken-224', '224', NULL, 1, 1, '1970-01-01T00:00:00.000Z'),
  (3, 'ken-33', '33', NULL, 1, 2, '1970-01-01T00:00:00.000Z'),
  (3, 'ken-infinity', 'Infinity', NULL, 1, 3, '1970-01-01T00:00:00.000Z');
