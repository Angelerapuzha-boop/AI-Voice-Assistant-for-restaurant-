-- Inventory splits into two views: 'dish' lines (auto-depleted by
-- confirmed orders, restock the prepped/servable stock) and 'raw'
-- lines (purchasable ingredients and consumables, counted and
-- restocked manually when doing the shopping).

ALTER TABLE inventory_items
  ADD COLUMN category text NOT NULL DEFAULT 'dish'
  CHECK (category IN ('dish', 'raw'));

-- Seed a practical raw-materials purchase list for a kebab/meatbox shop.
INSERT INTO inventory_items (restaurant_id, name, unit, current_qty, reorder_level, par_level, category)
SELECT r.id, v.name, v.unit, v.qty, v.reorder, v.par, 'raw'
FROM restaurants r
CROSS JOIN (VALUES
  ('Chicken (raw)',        'kg',  40, 10, 40),
  ('Lamb (raw)',           'kg',  30,  8, 30),
  ('Beef (raw)',           'kg',  20,  5, 20),
  ('Falafel mix',          'kg',  10,  3, 10),
  ('Flatbread wraps',      'pcs', 150, 40, 150),
  ('Burger buns',          'pcs', 80, 20, 80),
  ('Chips (frozen)',       'kg',  50, 15, 50),
  ('Rice',                 'kg',  40, 10, 40),
  ('Lettuce',              'kg',  15,  4, 15),
  ('Tomatoes',             'kg',  15,  4, 15),
  ('Onions',               'kg',  15,  4, 15),
  ('Tabouli mix',          'kg',  8,   2, 8),
  ('Pickles',              'kg',  8,   2, 8),
  ('Cheese',               'kg',  10,  3, 10),
  ('Hummus',               'kg',  8,   2, 8),
  ('Garlic sauce',         'L',   12,  3, 12),
  ('Chilli sauce',         'L',   10,  3, 10),
  ('BBQ sauce',            'L',   8,   2, 8),
  ('Tomato sauce',         'L',   8,   2, 8),
  ('Sweet chilli sauce',   'L',   8,   2, 8),
  ('Tahini sauce',         'L',   8,   2, 8),
  ('Cooking oil',          'L',   30,  8, 30),
  ('Soft drink cans (stock)', 'pcs', 120, 30, 120),
  ('Water bottles (stock)',   'pcs', 60, 15, 60),
  ('1.25L bottles (stock)',   'pcs', 40, 10, 40),
  ('Ayran (stock)',           'pcs', 40, 10, 40),
  ('Takeaway boxes',       'pcs', 200, 50, 200),
  ('Paper bags',           'pcs', 300, 80, 300),
  ('Napkins',              'pcs', 500, 150, 500)
) AS v(name, unit, qty, reorder, par)
ON CONFLICT (restaurant_id, name) DO NOTHING;
