-- Master-prompt add-ons: returning customers, queue-aware ready estimates,
-- and secure customer tracking.

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  history_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_order_at timestamptz,
  UNIQUE (restaurant_id, phone_e164)
);

ALTER TABLE orders ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN first_promised_ready_at timestamptz;
ALTER TABLE orders ADD COLUMN current_estimated_ready_at timestamptz;
-- Tracking token: random secret handed to the customer; only its hash is stored.
ALTER TABLE orders ADD COLUMN tracking_token_hash text UNIQUE;

CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);

-- Deterministic kitchen estimate settings (explainable lane model).
ALTER TABLE restaurant_settings ADD COLUMN kitchen_capacity integer NOT NULL DEFAULT 3
  CHECK (kitchen_capacity >= 1);
ALTER TABLE restaurant_settings ADD COLUMN simple_baseline_seconds integer NOT NULL DEFAULT 600
  CHECK (simple_baseline_seconds >= 60);
ALTER TABLE restaurant_settings ADD COLUMN complex_baseline_seconds integer NOT NULL DEFAULT 1200
  CHECK (complex_baseline_seconds >= 60);
