# Implementation plan — master-prompt coverage

Maps `Meat_Box_Claude_Code_Master_Prompt.md` requirements to this repository.
Status: ✅ implemented · 🟡 partial/adapted · ⏳ deferred (per the master
prompt's own stop conditions: "do not build Phase 3/4 infrastructure before
the core ordering loop works").

## Phase 1–2 (core ordering + phone-to-kitchen loop)

| Requirement | Status | Where |
| --- | --- | --- |
| pnpm TS-strict monorepo, Fastify voice WS, Next web, Postgres migrations | ✅ | repo layout; `packages/core/migrations` |
| Integer-cent pricing, server-side totals, no model arithmetic | ✅ | `core/src/domain/pricing.ts` + tests |
| Draft → confirm state machine; drafts never reach the kitchen | ✅ | `orders.ts` (kitchen queries exclude drafts) |
| Commit-once idempotent confirmation, atomic order + notification outbox | ✅ | `confirmOrder` (FOR UPDATE) + outbox in same tx |
| Notification failure never rolls back an order; retries + dashboard alert | ✅ | `notifications.ts`, `owner_sms_alert` |
| Takeaway-first: never ask takeaway vs dine-in | ✅ | prompt v3 (dine-in still supported if the caller asks) |
| Greeting "Meat Box, what can I get you?", <10-word replies, listen first | ✅ | settings + `agent/prompt.ts` |
| Menu resolution: aliases, trigram fuzzy, ambiguity → clarify, enquiry ≠ cart | ✅ | `menu.ts` searchMenu + prompt + tests |
| Modifier group min/max, sold-out, line splitting, "make that two" | ✅ | order engine + agent tests |
| Strict tools, server-injected context, no arbitrary SMS/status tools | ✅ | `agent/tools.ts` (caller/restaurant scoped server-side) |
| ConversationRelay: signature-validated webhook, WSS token, barge-in, serialized turns | ✅ | `apps/voice` |
| Returning customers + repeat orders at current prices, caller-ID-scoped | ✅ | `customers.ts`, `get_repeat_candidate` / `repeat_last_order`, tests |
| Deterministic queue-aware ready estimate (lane model, spec test scenario) | ✅ | `eta.ts` + `eta.spec.ts`; spoken as "about N minutes" |
| first_promised_ready_at immutable + current estimate column | ✅ | migration 0004 (recalc-on-queue-change deferred) |
| Customer tracking SMS + secure token track page + READY SMS | ✅ | `/track/[token]` (hashed token), status route |
| Kitchen display: big cards, sound, realtime + 7s failsafe, reconnect | ✅ | `/kitchen` |
| Counter orders visible to queue (POS) | ✅ | `/pos` (source=pos) |
| Simulator shares the real orchestrator | ✅ | `/admin/simulator` |
| Owner approval of menu/prices before live | ✅ | seed `[site]`/`[rep]` tags + LAUNCH_CHECKLIST |
| Overnight hours, closed-kitchen refusal, future-order window | ✅ | `hours.ts` + guards + tests |
| Allergen honesty, no bookings (no tool exists), prompt-injection scoping | ✅ | prompt + structural |
| Watchdog self-healing processes, crash guards, health endpoints | ✅ | `infra/serve-meatbox.ps1`, fatal guards |
| Conversation evaluations (spec §17 list) | ✅ | 69 core + 11 voice tests cover 1–14 in essence |

## Adapted (🟡) — documented deviations

- **Supabase Auth/Realtime/RLS** → bcrypt sessions + LISTEN/NOTIFY→SSE +
  server-side tenancy (single restaurant). See `docs/DECISIONS.md`.
- **Quote/confirmation tables** (order_quotes, confirmations, challenges) →
  enforced behaviourally: every cart mutation returns current state, confirm
  requires that state + explicit yes; idempotent commit. Full quote-versioning
  ledger deferred until multi-channel confirmation exists.
- **Visual confirmation path** (review link + tap Confirm) → deferred; voice
  confirmation only. Tracking page is read-only (no Confirm button ever).
- **Demo isolation (is_demo)** → simulator orders are real rows in the dev
  database and are cancelled after each demo cycle (single-environment dev).
- **Delay re-estimation / delay SMS with cooldown** → estimate stored per
  order; automatic requote-on-delay deferred.

## Deferred (⏳) — Phase 3/4 per the master prompt's own sequencing

- Collection kiosk, OTP pickup verification, `/collection` screen.
- PaymentProvider interface + Stripe Terminal sandbox (POS records
  cash/card/tap method today; Square order push exists for reporting).
- Ingredients, recipes, usage estimates, demand forecasting.
- Multi-restaurant tenancy + per-device credentials.
- OpenAPI document generation.

## Evidence

`pnpm test` → 80 tests green (core 69, voice 11). Live verifications logged in
git history: MB1014 (takeaway-first + spoken ETA), MB1013 (kitchen <2s),
MB1010 (real phone call), tracking SMS content asserted in `repeat.spec.ts`.
