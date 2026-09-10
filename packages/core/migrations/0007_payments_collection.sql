-- Phase 3 (spec 14): collection and payment.
-- Payments are a reconciled ledger: only verified provider settlement or an
-- authorised, audited manual payment can flip an order to paid. Kiosk lookups
-- are verified (order number + pickup code), rate-limited and non-enumerating.

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('mock_terminal', 'square_terminal', 'manual')),
  method text NOT NULL CHECK (method IN ('terminal', 'cash', 'card', 'tap')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'AUD',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  provider_payment_id text UNIQUE,
  idempotency_key text UNIQUE NOT NULL,
  failure_reason text NOT NULL DEFAULT '',
  authorised_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
-- Concurrent duplicate attempts for the same unpaid balance are impossible.
CREATE UNIQUE INDEX payments_one_pending_per_order ON payments (order_id) WHERE status = 'pending';
CREATE INDEX payments_order_idx ON payments (order_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments (status, created_at DESC);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider_refund_id text UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  reason text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);

-- Kiosk lookup rate limiting (per IP and per attempted order number).
CREATE TABLE kiosk_lookup_failures (
  id bigserial PRIMARY KEY,
  ip text NOT NULL DEFAULT '',
  order_key text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kiosk_fail_ip_idx ON kiosk_lookup_failures (ip, at DESC);
CREATE INDEX kiosk_fail_order_idx ON kiosk_lookup_failures (order_key, at DESC);
