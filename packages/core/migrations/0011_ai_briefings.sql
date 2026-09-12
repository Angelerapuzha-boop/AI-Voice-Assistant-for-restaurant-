-- Cached AI-adviser output for the insights page: regenerating costs an
-- LLM call, so the latest briefing is stored and reused for a few hours
-- (or until the owner hits Regenerate).

CREATE TABLE ai_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  generated_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE INDEX ai_briefings_latest_idx ON ai_briefings (restaurant_id, generated_at DESC);
