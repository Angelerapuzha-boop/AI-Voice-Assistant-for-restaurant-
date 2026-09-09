CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================ restaurants
CREATE TABLE restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone_display text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'Australia/Perth',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE restaurant_settings (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  owner_sms_number text NOT NULL DEFAULT '',
  customer_sms_enabled boolean NOT NULL DEFAULT false,
  future_orders_enabled boolean NOT NULL DEFAULT true,
  min_prep_minutes integer NOT NULL DEFAULT 20 CHECK (min_prep_minutes >= 0),
  max_future_hours integer NOT NULL DEFAULT 8 CHECK (max_future_hours >= 1),
  order_number_prefix text NOT NULL DEFAULT 'MB',
  ai_greeting text NOT NULL DEFAULT 'Hi, thanks for calling Meatbox. How can I help you today?',
  ai_model text NOT NULL DEFAULT '',
  fallback_behaviour text NOT NULL DEFAULT 'take_message'
    CHECK (fallback_behaviour IN ('take_message', 'end_politely')),
  tts_provider text NOT NULL DEFAULT '',
  tts_voice text NOT NULL DEFAULT '',
  tts_language text NOT NULL DEFAULT 'en-AU',
  stt_provider text NOT NULL DEFAULT '',
  stt_model text NOT NULL DEFAULT '',
  speech_hints text NOT NULL DEFAULT 'Meatbox, Gozleme, Manakish, Shawarma, Hummus, Tahini, Falafel, Kebab, Tabouli, Kafta, Shish Taouk, Lahme, Pide, Halloumi',
  recording_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE restaurant_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  opens_at time,
  closes_at time, -- closes_at <= opens_at means the window runs past midnight
  is_closed boolean NOT NULL DEFAULT false,
  UNIQUE (restaurant_id, day_of_week)
);

-- ============================================================ auth
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ============================================================ menu
CREATE TABLE menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (restaurant_id, slug)
);

CREATE TABLE menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  image_url text NOT NULL DEFAULT '',
  is_vegetarian boolean NOT NULL DEFAULT false,
  is_available boolean NOT NULL DEFAULT true,
  is_sold_out boolean NOT NULL DEFAULT false,
  is_popular boolean NOT NULL DEFAULT false,
  prep_notes text NOT NULL DEFAULT '',
  aliases text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_category_idx ON menu_items (category_id);
CREATE INDEX menu_items_name_trgm_idx ON menu_items USING gin (name gin_trgm_ops);

CREATE TABLE menu_item_modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  min_select integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select integer NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX modifier_groups_item_idx ON menu_item_modifier_groups (menu_item_id);

CREATE TABLE menu_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES menu_item_modifier_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  is_available boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX modifiers_group_idx ON menu_item_modifiers (group_id);

CREATE TABLE daily_specials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  quantity_limit integer CHECK (quantity_limit IS NULL OR quantity_limit > 0),
  quantity_used integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX specials_window_idx ON daily_specials (restaurant_id, starts_at, ends_at);

-- ============================================================ calls
CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  twilio_call_sid text UNIQUE,
  caller_number text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_seconds integer,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'failed')),
  outcome text CHECK (outcome IS NULL OR outcome IN (
    'ORDER_COMPLETED', 'MENU_ENQUIRY', 'CALL_DROPPED',
    'CUSTOMER_CANCELLED', 'NEEDS_REVIEW', 'NO_ORDER')),
  order_id uuid,
  transcript jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_started_idx ON calls (restaurant_id, started_at DESC);

CREATE TABLE call_events (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_events_call_idx ON call_events (call_id);

-- ============================================================ orders
CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_order_number text UNIQUE, -- assigned at confirmation, e.g. MB1042
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_name text NOT NULL DEFAULT '',
  customer_phone text NOT NULL DEFAULT '',
  order_type text NOT NULL DEFAULT 'takeaway' CHECK (order_type IN ('takeaway', 'dine_in')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'new', 'accepted', 'preparing', 'ready',
    'completed', 'cancelled', 'needs_review')),
  requested_asap boolean NOT NULL DEFAULT true,
  requested_time timestamptz,
  confirmed_at timestamptz,
  subtotal_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  customer_notes text NOT NULL DEFAULT '',
  allergy_notes text NOT NULL DEFAULT '',
  internal_notes text NOT NULL DEFAULT '',
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  owner_sms_alert boolean NOT NULL DEFAULT false, -- true when owner SMS exhausted retries
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_idx ON orders (restaurant_id, status, created_at DESC);
CREATE INDEX orders_phone_idx ON orders (customer_phone);
CREATE INDEX orders_number_idx ON orders (public_order_number);

ALTER TABLE calls
  ADD CONSTRAINT calls_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  special_id uuid REFERENCES daily_specials(id) ON DELETE SET NULL,
  name_snapshot text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  special_instructions text NOT NULL DEFAULT '',
  removals text[] NOT NULL DEFAULT '{}',
  line_total_cents integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id uuid REFERENCES menu_item_modifiers(id) ON DELETE SET NULL,
  group_name_snapshot text NOT NULL DEFAULT '',
  name_snapshot text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0
);
CREATE INDEX order_item_modifiers_item_idx ON order_item_modifiers (order_item_id);

-- ============================================================ notifications
CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('owner_sms', 'customer_sms', 'review_sms')),
  to_number text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'gave_up')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  provider_sid text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_pending_idx ON notification_attempts (status, next_attempt_at);

-- ============================================================ audit
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  restaurant_id uuid,
  actor text NOT NULL, -- user email, 'ai', or 'system'
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL DEFAULT '',
  changes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

-- ============================================================ realtime
-- Kitchen dashboard subscribes via LISTEN order_events (bridged to SSE).
CREATE OR REPLACE FUNCTION notify_order_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('order_events', json_build_object(
    'orderId', NEW.id,
    'status', NEW.status,
    'op', TG_OP
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_notify
  AFTER INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION notify_order_change();
