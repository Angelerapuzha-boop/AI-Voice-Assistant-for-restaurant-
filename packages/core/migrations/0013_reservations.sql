-- ============================================================ reservations
-- Table-reservation system (replaces food ordering as the phone assistant's
-- business function). Additive: does not touch any ordering table.

-- Per-restaurant reservation configuration. Deliberately simple to start
-- (covers-per-slot cap + max party); real table inventory can come later.
CREATE TABLE reservation_settings (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  reservations_enabled boolean NOT NULL DEFAULT true,
  max_covers_per_slot integer NOT NULL DEFAULT 20 CHECK (max_covers_per_slot >= 1),
  max_party_size integer NOT NULL DEFAULT 10 CHECK (max_party_size >= 1),
  slot_interval_minutes integer NOT NULL DEFAULT 15 CHECK (slot_interval_minutes BETWEEN 5 AND 60),
  turnover_minutes integer NOT NULL DEFAULT 90 CHECK (turnover_minutes BETWEEN 15 AND 240),
  min_advance_minutes integer NOT NULL DEFAULT 30 CHECK (min_advance_minutes >= 0),
  max_advance_days integer NOT NULL DEFAULT 120 CHECK (max_advance_days >= 1),
  ref_prefix text NOT NULL DEFAULT 'R',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  public_ref text NOT NULL,                       -- short human reference, e.g. "R1042"
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  reservation_date date NOT NULL,
  reservation_time time NOT NULL,                 -- 24h local (restaurant timezone)
  party_size integer NOT NULL CHECK (party_size >= 1),
  status text NOT NULL DEFAULT 'CONFIRMED'
    CHECK (status IN ('CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW')),
  special_requests text NOT NULL DEFAULT '',
  high_chair boolean NOT NULL DEFAULT false,
  accessibility boolean NOT NULL DEFAULT false,
  occasion text NOT NULL DEFAULT '',
  seating_pref text NOT NULL DEFAULT '' CHECK (seating_pref IN ('', 'indoor', 'outdoor')),
  source text NOT NULL DEFAULT 'phone',
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  idempotency_key text,                           -- collapses accidental double-submits
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, public_ref)
);

-- Idempotency: the same booking request (retry / duplicate tool call) can never
-- create two rows.
CREATE UNIQUE INDEX reservations_idempotency
  ON reservations (restaurant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Accidental exact-duplicate active booking guard (same phone, date, time, size).
CREATE UNIQUE INDEX reservations_no_dup_active
  ON reservations (restaurant_id, customer_phone, reservation_date, reservation_time, party_size)
  WHERE status = 'CONFIRMED';

-- Fast lookup by caller for modify/cancel, and by slot for availability.
CREATE INDEX reservations_lookup
  ON reservations (restaurant_id, customer_phone, reservation_date);
CREATE INDEX reservations_slot
  ON reservations (restaurant_id, reservation_date, reservation_time)
  WHERE status = 'CONFIRMED';

-- Audit trail for every create / modify / cancel.
CREATE TABLE reservation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('created', 'modified', 'cancelled', 'completed', 'no_show')),
  detail jsonb NOT NULL DEFAULT '{}',
  actor text NOT NULL DEFAULT 'phone',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_audit_res ON reservation_audit (reservation_id, created_at);

-- Seed default reservation settings for every existing restaurant.
INSERT INTO reservation_settings (restaurant_id)
  SELECT id FROM restaurants
  ON CONFLICT (restaurant_id) DO NOTHING;
