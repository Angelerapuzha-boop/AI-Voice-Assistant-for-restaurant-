-- Suppliers + automatic stock replacement. When stock hits its alert
-- level, the system raises a replenishment request to the item's
-- supplier: SMS with a secure confirm link (and optionally an automated
-- voice call). The supplier confirms/declines on a public page; the
-- owner marks goods received, which restocks the item.

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  sms_enabled boolean NOT NULL DEFAULT true,
  call_enabled boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);

ALTER TABLE inventory_items ADD COLUMN supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE inventory_items ADD COLUMN auto_replenish boolean NOT NULL DEFAULT false;

CREATE TABLE replenishment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  qty numeric(12,2) NOT NULL,
  unit text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'confirmed', 'declined', 'received', 'cancelled')),
  token_hash text UNIQUE NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  received_at timestamptz,
  note text NOT NULL DEFAULT ''
);
CREATE INDEX replenishment_open_idx ON replenishment_orders (inventory_item_id)
  WHERE status IN ('requested', 'confirmed');
CREATE INDEX replenishment_list_idx ON replenishment_orders (restaurant_id, requested_at DESC);

ALTER TABLE notification_attempts DROP CONSTRAINT notification_attempts_kind_check;
ALTER TABLE notification_attempts ADD CONSTRAINT notification_attempts_kind_check
  CHECK (kind IN ('owner_sms', 'customer_sms', 'review_sms', 'supplier_sms', 'webhook', 'square_order'));
