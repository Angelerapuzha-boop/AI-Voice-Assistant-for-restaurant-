-- POS interface + Square platform integration.

ALTER TABLE orders ADD COLUMN source text NOT NULL DEFAULT 'phone'
  CHECK (source IN ('phone', 'pos', 'web'));
ALTER TABLE orders ADD COLUMN payment_method text NOT NULL DEFAULT ''
  CHECK (payment_method IN ('', 'cash', 'card', 'tap'));
ALTER TABLE orders ADD COLUMN paid_at timestamptz;

-- Square OAuth connection (one per restaurant).
CREATE TABLE square_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  merchant_id text NOT NULL DEFAULT '',
  location_id text NOT NULL DEFAULT '',
  access_token text NOT NULL,
  refresh_token text NOT NULL DEFAULT '',
  expires_at timestamptz,
  environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('sandbox', 'production')),
  push_orders boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now()
);

-- Square catalog ids for idempotent menu import/sync.
ALTER TABLE menu_categories ADD COLUMN square_id text NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN square_id text NOT NULL DEFAULT '';
ALTER TABLE menu_item_modifier_groups ADD COLUMN square_id text NOT NULL DEFAULT '';
ALTER TABLE menu_item_modifiers ADD COLUMN square_id text NOT NULL DEFAULT '';

-- Square order pushes ride the notification outbox (retries included).
ALTER TABLE notification_attempts DROP CONSTRAINT notification_attempts_kind_check;
ALTER TABLE notification_attempts ADD CONSTRAINT notification_attempts_kind_check
  CHECK (kind IN ('owner_sms', 'customer_sms', 'review_sms', 'webhook', 'square_order'));
