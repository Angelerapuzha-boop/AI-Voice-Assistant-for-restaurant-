-- Visual confirmation path (spec 4: VISUAL) and material-delay SMS (spec 12).

-- Review link on a draft: single-use confirm token, only the hash is stored.
-- The order stays a draft (drafts never reach the kitchen) until the
-- customer's explicit POST confirms it; an expired link can never commit.
ALTER TABLE orders ADD COLUMN review_token_hash text UNIQUE;
ALTER TABLE orders ADD COLUMN review_expires_at timestamptz;

-- The ready estimate the customer was last told about (first promise or the
-- last delay SMS). Baseline + dedup/cooldown for material-delay messages.
ALTER TABLE orders ADD COLUMN delay_notified_ready_at timestamptz;

-- Owner-tunable knobs.
ALTER TABLE restaurant_settings ADD COLUMN review_ttl_seconds integer NOT NULL DEFAULT 1800
  CHECK (review_ttl_seconds >= 300);
ALTER TABLE restaurant_settings ADD COLUMN delay_notify_threshold_seconds integer NOT NULL DEFAULT 600
  CHECK (delay_notify_threshold_seconds >= 60);

CREATE INDEX orders_review_expiry_idx ON orders (review_expires_at)
  WHERE status = 'draft' AND review_expires_at IS NOT NULL;
