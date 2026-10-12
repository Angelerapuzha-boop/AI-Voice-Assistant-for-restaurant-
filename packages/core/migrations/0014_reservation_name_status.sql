-- ============================================================ name status
-- Final production acceptance (Kevin 2026-10-10): when the line's STT makes a
-- caller's spoken name impossible to capture — even after re-asking and asking
-- them to spell it — the booking is kept under the caller's own phone number
-- rather than lost, but we must NEVER pretend a name was captured. Record that
-- the name is unresolved and flag the row so a human follows it up.
ALTER TABLE reservations
  ADD COLUMN name_status text NOT NULL DEFAULT 'provided'
    CHECK (name_status IN ('provided', 'unresolved')),
  ADD COLUMN needs_staff_attention boolean NOT NULL DEFAULT false;

-- Fast lookup of the rows a human still needs to touch.
CREATE INDEX reservations_staff_attention
  ON reservations (restaurant_id, reservation_date)
  WHERE needs_staff_attention;
