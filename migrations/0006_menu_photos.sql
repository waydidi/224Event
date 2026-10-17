-- Generated from src/db/migrations.ts. Do not edit directly.
ALTER TABLE menu_items ADD COLUMN thumb_url TEXT;
UPDATE menu_items SET image_url = '/static/menu/the-morning-light.webp', thumb_url = '/static/menu/the-morning-light-thumb.webp'
  WHERE code = 'the-morning-light';
