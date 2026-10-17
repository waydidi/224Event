-- Generated from src/db/migrations.ts. Do not edit directly.
ALTER TABLE menu_items ADD COLUMN full_url TEXT;
UPDATE menu_items SET full_url = '/static/menu/the-morning-light-full.webp' WHERE code = 'the-morning-light';
UPDATE menu_items SET full_url = '/static/menu/naoko-full.webp' WHERE code = 'naoko';
