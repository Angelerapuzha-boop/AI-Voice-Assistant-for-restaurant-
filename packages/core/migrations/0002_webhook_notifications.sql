-- Allow webhook deliveries (n8n events) to reuse the notification outbox
-- and its retry machinery. For kind='webhook', to_number holds the URL and
-- body holds the JSON payload.
ALTER TABLE notification_attempts DROP CONSTRAINT notification_attempts_kind_check;
ALTER TABLE notification_attempts ADD CONSTRAINT notification_attempts_kind_check
  CHECK (kind IN ('owner_sms', 'customer_sms', 'review_sms', 'webhook'));
