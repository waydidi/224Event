-- Generated from src/db/migrations.ts. Do not edit directly.
UPDATE menu_items SET price_satang = CASE (SELECT code FROM menu_categories c WHERE c.id = menu_items.category_id)
  WHEN 'kens-birthday' THEN 52000 WHEN 'signature' THEN 48000 WHEN 'classic' THEN 36000 END
WHERE price_satang IS NULL;
