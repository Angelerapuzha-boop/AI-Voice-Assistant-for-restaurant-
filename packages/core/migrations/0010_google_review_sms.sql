-- Google-review ask: one hour after an order completes, text the customer
-- a review link — strictly ONCE per customer for life (keyed by phone).
-- Inert until the owner pastes the shop's Google review URL in Settings.

ALTER TABLE restaurant_settings ADD COLUMN google_review_url text NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN review_sms_sent_at timestamptz;
