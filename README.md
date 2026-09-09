# Meatbox WA — AI Telephone Ordering System

An AI receptionist that answers Meatbox's phone, talks naturally in an
Australian voice, explains the menu, takes takeaway/dine-in food orders,
and pushes each confirmed order to the kitchen dashboard and the owner's
phone by SMS — so nobody has to stop cooking to answer the phone.

**This is a restaurant ORDER-TAKING system, not a generic receptionist.
It never takes table reservations.**

## Architecture

```
Caller
  → Twilio AU number (voice webhook, signature-validated)
  → Twilio ConversationRelay (en-AU STT/TTS, barge-in)
  → wss:// Voice service (apps/voice, Fastify + WebSocket)
  → Claude agent (packages/core/src/agent) — 18 strict tools
  → PostgreSQL (single source of truth: menu, prices, hours, specials)
  → confirmed order:  orders table  +  SMS outbox (retry w/ backoff)
  → kitchen dashboard (apps/web /kitchen) via Postgres LISTEN/NOTIFY → SSE
```

- **`packages/core`** — everything shared: env, DB client + SQL migrations,
  domain logic (integer-cent pricing, overnight-capable hours, order engine
  with idempotent confirmation, specials, SMS outbox), the Claude agent
  (system prompt, tools, streaming engine), seed.
- **`apps/voice`** — long-running service (port 4811): Twilio voice webhook →
  ConversationRelay TwiML, the relay WebSocket session, SMS worker,
  simulator API. Deploy somewhere with persistent WebSockets (Fly/Render/
  Railway) — never serverless.
- **`apps/web`** — Next.js 15 (port 4810): public menu page, staff login,
  kitchen dashboard, full admin (menu/modifiers, specials, hours, settings,
  voice settings, Test AI simulator, orders, calls, analytics, users).

Key guarantees:

- The AI **never** invents menu items, prices or specials — every fact comes
  from a tool call against PostgreSQL, and every total is calculated
  server-side in integer cents.
- `confirm_order` is refused until the AI has read the latest order summary
  back (deterministic guard) — and is **idempotent**, so a reconnect can
  never double-create an order.
- Owner SMS is enqueued **in the same transaction** as the confirmation;
  a failed SMS retries with backoff and, after giving up, flags the order
  in red on the dashboard. A confirmed order never disappears.
- A call that drops mid-order leaves a `needs_review` order; one that drops
  after confirmation keeps its confirmed order.

## Local setup (Windows-friendly)

Prereqs: Node 22+, pnpm 10, Docker Desktop.

```
cd meatbox-ai
cp .env.example .env         # then fill in keys (see below)
pnpm install
pnpm db:up                   # Postgres 16 in Docker on 127.0.0.1:5441
pnpm db:migrate
pnpm db:seed                 # Meatbox menu + owner login + demo special
pnpm dev:voice               # voice service on 127.0.0.1:4811
pnpm dev:web                 # web app on   127.0.0.1:4810
```

Seed login: `owner@meatbox.local` / `MeatboxAdmin!2026` — **change it in
Admin → Users before launch.**

Run everything's tests: `pnpm test` (needs `pnpm db:up` first).
`pnpm --filter @meatbox/core run demo-order` drops one confirmed demo order
into the kitchen dashboard (cancel it there when done).

## Anthropic setup

1. Create an API key at console.anthropic.com and set `ANTHROPIC_API_KEY`.
2. `ANTHROPIC_MODEL` defaults to `claude-sonnet-5`; you can override per
   restaurant in Admin → Voice assistant (e.g. `claude-haiku-4-5-20251001`
   for lower latency).

Without a key the phone line answers with a polite "call back shortly"
message and the simulator explains what's missing — nothing crashes.

## Twilio setup

1. Buy/pick an **Australian** number with Voice capability.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
3. Point the number's **Voice webhook** (HTTP POST) at
   `https://<voice-service-host>/twilio/voice`.
4. Set `VOICE_PUBLIC_URL=https://<voice-service-host>` and
   `VOICE_WEBSOCKET_URL=wss://<voice-service-host>/twilio/relay` so TwiML
   and signature validation use the public URLs.
5. Webhooks are rejected unless the `X-Twilio-Signature` matches; the
   ConversationRelay WebSocket additionally requires a per-call HMAC token
   embedded in the TwiML.

For local phone testing, expose 4811 via a tunnel (e.g. cloudflared) and use
that hostname in the two URLs above.

### Australian voice

ConversationRelay is configured from **Admin → Voice assistant** (stored in
the DB — nothing hard-coded): TTS provider (Google/Amazon/ElevenLabs), voice
name, `en-AU` language, STT provider (Deepgram/Google) and speech model.
Defaults come from `TWILIO_TTS_PROVIDER` / `TWILIO_TTS_VOICE` /
`TWILIO_STT_PROVIDER`. Menu item names are automatically added as speech
hints so words like "Gozleme" and "Shish Taouk" transcribe correctly.

## SMS

- `OWNER_NOTIFICATION_PHONE` (or Admin → Settings → Owner SMS number) gets
  an itemised, kitchen-readable SMS the moment an order is confirmed.
- Optional customer confirmation SMS: Admin → Settings toggle.
- **`SMS_MODE=log`** (default) records + logs instead of sending — flip to
  `live` in production. Failed sends retry (10s → 30s → 60s → 3m → 10m),
  then mark the order with a red ⚠ on the dashboard; "Resend owner SMS" is
  on the order detail page.

## Day-to-day restaurant operation

- **Kitchen**: open `/kitchen` on a phone/tablet, tap "Sound on". New orders
  appear instantly with a triple beep; tap ACCEPT → START PREPARING → READY
  → COMPLETE.
- **Menu**: Admin → Menu. Tap AVAILABLE/SOLD OUT to toggle an item — the AI
  respects it on the very next call. Expand an item to edit price,
  description, spoken aliases and option groups (sauces, sizes, extras).
- **Specials**: Admin → Daily specials — name, price, time window, optional
  quantity limit. Active specials appear on the website and in the AI.
- **Hours**: Admin → Hours (supports past-midnight closing, e.g. 5pm–1am).
- **Test a call without phoning**: Admin → Test AI — type what a caller
  would say; you see the AI's replies, its tool calls and the live cart.

## Deployment

- **Voice service**: `apps/voice/Dockerfile` + `fly.toml.example`
  (Sydney region, no auto-stop — calls must never hit a cold start).
- **Web**: `apps/web/Dockerfile`, or Vercel (all pages are dynamic).
- **Database**: any managed Postgres 16 (Supabase works — paste its
  connection string into `DATABASE_URL`; see docs/DECISIONS.md on RLS).
- Run `pnpm db:migrate` against the production database, then `db:seed`,
  then walk through `LAUNCH_CHECKLIST.md` before pointing the real number
  at it.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Caller hears "assistant unavailable" | `ANTHROPIC_API_KEY` unset/invalid — see `/health` on the voice service |
| Webhook 403 | `VOICE_PUBLIC_URL` doesn't exactly match the URL Twilio calls (scheme/host/path) |
| No SMS arriving | `SMS_MODE` still `log`? Owner number set? Order detail page shows attempts + errors |
| Kitchen not updating | SSE blocked by a proxy — the board also polls every 30 s; check `/api/orders/stream` |
| "No restaurant configured" | run `pnpm db:seed` |
| Voice service port in use | another ARC app grabbed 4811 — adjust `VOICE_PORT` everywhere |

Never commit `.env`. All services bind to loopback in development.
