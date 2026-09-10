# Meatbox AI — Production Launch Checklist

Do every item with the restaurant owner before pointing the real phone
number at the system.

## Menu & prices (owner sign-off required)

- [ ] Walk the complete Meatbox menu against Admin → Menu; add anything missing
- [ ] Verify EVERY price — seed items whose description contains `[rep]` are
      representative placeholders, not real prices; `[site]` prices came from
      meatboxwa.com.au on 2026-09-09 and may have changed. Do not assume
      delivery-platform prices equal direct prices. Remove the `[rep]`/`[site]`
      tags from descriptions as each is confirmed (the AI reads descriptions aloud)
- [ ] Verify required modifier groups (meat choice, base, size, drink flavour)
      on every item that needs one
- [ ] Verify vegetarian flags and ingredient descriptions (used for allergy answers)
- [ ] Delete or replace the seeded demo special ("Half Chicken & Chips Deal")

## Configuration

- [ ] Verify opening hours in Admin → Hours (currently 5:00pm–1:00am daily)
- [ ] Verify owner SMS number in Admin → Settings
- [ ] Verify minimum prep time and future-order window
- [ ] Change the seed owner password; create individual staff logins; disable
      any test users
- [ ] Set `SMS_MODE=live` and all production secrets on the servers (never in git)

## Voice

- [ ] Verify the Australian voice (Admin → Voice assistant) by calling and
      listening — adjust provider/voice until it sounds right
- [ ] Verify the greeting wording
- [ ] Verify caller ID capture (order should carry the caller's number)

## End-to-end call tests (use a real phone)

- [ ] Takeaway order: menu question → order → amendment → confirm → SMS +
      dashboard within seconds
- [ ] Dine-in order (confirm no table "booking" is implied)
- [ ] Ask "can I book a table?" — expect polite refusal, no record created
- [ ] Ask today's special — expect the real one (then with no specials active,
      expect "no special today")
- [ ] Mark an item sold out mid-service, order it — expect apology + alternative
- [ ] Ambiguous item ("the box") — expect a clarifying question
- [ ] Serious allergy question — expect ingredients + no safety guarantee, and
      the allergy note printed on the order
- [ ] Hang up right after saying "yes" — order must still arrive
- [ ] Hang up mid-order — order appears as NEEDS REVIEW
- [ ] Call outside opening hours — expect closed message / future order only

## Failure drills

- [ ] SMS failure drill (wrong owner number temporarily): order stays on the
      dashboard with a red ⚠, resend works after fixing the number
- [ ] Voice service restart during idle: `/health` recovers, next call works
- [ ] Verify Twilio signature validation is ON (a curl without the header → 403)

## Collection & payments (Phase 3)

- [ ] Decide the payments provider: leave `PAYMENTS_PROVIDER=mock_terminal`
      (kiosk shows a purple TEST badge, no real money) until Square is ready —
      never point real customers at the mock without the badge visible
- [ ] Square live path: create the app at developer.squareup.com → set
      SQUARE_APP_ID/SECRET → Admin → Integrations → Connect (owner clicks
      Allow) → pair the Square Terminal and set SQUARE_TERMINAL_DEVICE_ID →
      set SQUARE_WEBHOOK_SIGNATURE_KEY (webhook URL:
      https://voice-syd.example.com/payments/webhook/square) →
      switch PAYMENTS_PROVIDER=square_terminal → sandbox test checkout first
- [ ] Kiosk drill on the shop tablet: order number + pickup code from the
      tracking page → pay → PAID screen; wrong code five times → locked out
      with the same generic message
- [ ] Kitchen handover drill: COMPLETE an unpaid order — expect the
      cash/card/exception chooser, and the payment to appear under
      Admin → Payments
- [ ] Refund drill: owner login → Admin → Payments → partial refund; verify
      the audit entry and (for Square) the money actually returning
- [ ] Put /board on the shop TV if wanted (public, order numbers only)

## Infrastructure

- [ ] Verify database backups + a restore test
- [ ] Verify API keys are production keys with sane limits
- [ ] Verify the kitchen tablet/phone renders /kitchen well with sound enabled
- [ ] Verify privacy posture: call recording is OFF (transcripts only) and the
      team knows transcripts exist in Call logs
- [ ] Add monitoring (SENTRY_DSN) and confirm an alert path
