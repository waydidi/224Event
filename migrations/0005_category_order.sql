-- Generated from src/db/migrations.ts. Do not edit directly.
UPDATE menu_categories SET sort_order = CASE code WHEN 'kens-birthday' THEN 1 WHEN 'signature' THEN 2 WHEN 'classic' THEN 3 ELSE sort_order END;
