-- Inventory: stock on hand per item, depleted by confirmed orders and
-- restored on cancellation; movements are an auditable ledger. Menu items
-- map many-to-many onto inventory (default seed: one stock line per menu
-- item, 1 unit per order line) so ingredient-level tracking can be added
-- later without schema change.

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'serves',
  current_qty numeric(12,2) NOT NULL DEFAULT 0,
  reorder_level numeric(12,2) NOT NULL DEFAULT 0,
  par_level numeric(12,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  delta numeric(12,2) NOT NULL,
  reason text NOT NULL CHECK (reason IN ('order', 'order_cancelled', 'restock', 'adjustment', 'waste')),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  actor text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_item_idx ON inventory_movements (inventory_item_id, created_at DESC);
CREATE INDEX inventory_movements_order_idx ON inventory_movements (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE menu_item_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  qty_per_unit numeric(12,3) NOT NULL DEFAULT 1,
  UNIQUE (menu_item_id, inventory_item_id)
);
CREATE INDEX menu_item_ingredients_menu_idx ON menu_item_ingredients (menu_item_id);

-- Default seed: one stock line per active menu item (50 on hand, reorder
-- at 10, restock target 50), mapped 1:1. Owners tune levels in Admin.
INSERT INTO inventory_items (restaurant_id, name, unit, current_qty, reorder_level, par_level)
SELECT mi.restaurant_id, mi.name, 'serves', 50, 10, 50
FROM menu_items mi
WHERE mi.active
ON CONFLICT (restaurant_id, name) DO NOTHING;

INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, qty_per_unit)
SELECT mi.id, ii.id, 1
FROM menu_items mi
JOIN inventory_items ii ON ii.restaurant_id = mi.restaurant_id AND ii.name = mi.name
WHERE mi.active
ON CONFLICT (menu_item_id, inventory_item_id) DO NOTHING;
