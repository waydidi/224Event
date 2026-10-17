-- Generated from src/db/migrations.ts. Do not edit directly.
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
