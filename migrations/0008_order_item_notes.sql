-- Generated from src/db/migrations.ts. Do not edit directly.
ALTER TABLE order_items ADD COLUMN note TEXT NOT NULL DEFAULT '';
