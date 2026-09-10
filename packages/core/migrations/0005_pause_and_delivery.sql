-- Gap-closing pass against the master prompt.

-- Owner pause switch (spec 3: restaurant_settings.accepting_orders).
ALTER TABLE restaurant_settings ADD COLUMN accepting_orders boolean NOT NULL DEFAULT true;
ALTER TABLE restaurant_settings ADD COLUMN pause_reason text NOT NULL DEFAULT '';

-- SMS delivery lifecycle (queued/sent/delivered are not synonyms, spec 12).
ALTER TABLE notification_attempts ADD COLUMN delivery_status text NOT NULL DEFAULT '';
ALTER TABLE notification_attempts ADD COLUMN delivered_at timestamptz;
CREATE INDEX notification_provider_sid_idx ON notification_attempts (provider_sid);
