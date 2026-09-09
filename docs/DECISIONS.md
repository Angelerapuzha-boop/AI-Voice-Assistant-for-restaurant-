# Implementation decisions

Deviations from / interpretations of the build spec, per its instruction to
make sensible production decisions and document them.

1. **Plain PostgreSQL now, Supabase-ready.** No Supabase credentials existed
   at build time, so the system runs on Docker Postgres 16 with hand-written
   SQL migrations, and substitutes:
   - *Supabase Realtime* → Postgres `LISTEN/NOTIFY` bridged to Server-Sent
     Events (`/api/orders/stream`), with a 30 s polling fallback.
   - *Supabase Auth* → bcrypt password hashing + server-side session table
     with SHA-256-hashed random tokens in an HttpOnly cookie.
   - *Row Level Security* → all data access goes through server-side code
     that scopes by the single restaurant and checks the session; nothing
     talks to Postgres from the browser. If migrated onto Supabase with
     client-side access, RLS policies must be added at that point.
   Migrating = pointing `DATABASE_URL` at Supabase and re-running migrations.

2. **SMS worker lives inside the voice service** (3 s outbox poll) instead of
   a third deployable. One always-on process owns telephony + notifications;
   the outbox table means a crashed worker loses nothing.

3. **Confirmation is guarded twice.** The prompt instructs read-back + yes;
   deterministically, `confirm_order` fails unless `get_order_summary` /
   `calculate_order_total` was called after the last cart mutation, the
   customer has a name, the cart is non-empty, and (for ASAP orders) the
   kitchen is open. Confirmation is serialised with `SELECT … FOR UPDATE`
   and idempotent — a duplicate confirm returns the existing order.

4. **No reservation tooling exists at all** — the "no bookings" rule is
   enforced structurally (no tool can create one), not just by prompt.

5. **Modifier model**: option groups (required flag, min/max) with priced
   modifiers; free-text `removals` and `specialInstructions` carry "no onion"
   / "extra crispy". Specials are fixed-price items without modifiers
   (instructions still allowed).

6. **Money** is integer cents everywhere; DB `CHECK` constraints and runtime
   asserts reject floats/negatives. The LLM never sees or supplies arithmetic
   — it gets formatted strings.

7. **Prices seeded from the live site are tagged `[site]`, representative
   ones `[rep]`** in item descriptions so the owner review pass
   (LAUNCH_CHECKLIST) can't miss them. The Square ordering page renders its
   catalog client-side from an API, so only homepage-featured items had
   scrapeable prices.

8. **ConversationRelay specifics**: welcome greeting is spoken by Twilio
   (`welcomeGreeting`) and logged to the transcript; barge-in aborts the
   in-flight Claude stream and truncates history to what was actually spoken
   (`utteranceUntilInterrupt`); the WSS URL carries a per-call HMAC token
   because Twilio does not sign WebSocket upgrades; DTMF is ignored.

9. **Model default** is `claude-sonnet-5` for tool-use accuracy, overridable
   per restaurant (Admin → Voice) e.g. to Haiku 4.5 for latency. Streaming
   tokens are forwarded to TTS as they arrive, so first-word latency is low
   either way.

10. **Ports** 4810 (web), 4811 (voice), 5441 (Postgres) — chosen clear of the
    ~33 other ARC apps on this machine; loopback-only in development.

11. **Call recording is off by default** and there is no code path that
    records audio; `recording_enabled` exists as a settings flag for a future
    compliant implementation. Transcripts (text) are stored on the call row.

12. **Web tests**: the web layer is typechecked and its behaviour exercised
    through the API-level and browser smoke tests; unit tests concentrate on
    the domain/agent/voice layers where the money and the orders are.
