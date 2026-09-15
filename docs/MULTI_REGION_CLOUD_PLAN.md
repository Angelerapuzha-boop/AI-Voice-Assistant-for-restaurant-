# Meat Box AI Voice — Low-Latency Cloud Build Plan

Goal: fast, gapless ordering for callers **anywhere**, with geography removed as a
factor and the reliability ceiling of the single Windows box removed.

Status: PLAN (awaiting Kevin's go + cloud account). Nothing here is built yet.

**Decisions locked (2026-09-15):** Host = **Fly.io**. Voice vendor = **open to a
multi-region provider** for true global speed (Sally's exact ElevenLabs voice may
change / be re-cloned). → Build order: Phase 1 Fly.io US region keeping Sally
(ships in days), then Phase 2 pilot a multi-region voice layer (Cartesia TTS +
Deepgram STT) for genuinely-local speed worldwide. See §7 for the vendor research.

---

## 1. The core insight (measured, 2026-09-15)

The felt gap per reply is dominated by round-trips to the AI services, which are
**US-hosted**:

| Leg | Measured | Notes |
|-----|----------|-------|
| Server (Sydney) → ElevenLabs (US) network | ~80–140ms/RT | Scribe STT + Sally TTS |
| Server (Sydney) → Anthropic (US) network | ~80–140ms/RT | Claude / Haiku understanding |
| ElevenLabs processing (STT commit) | ~250–350ms | on top of network |
| ElevenLabs TTS first-byte | ~300ms | 0 when the phrase is cached |
| Anthropic (Haiku) understanding | ~1.1–1.5s | only on ambiguous turns |

Per reply there are up to **3 blocking US round-trips** (STT commit, TTS first
byte, LLM). Co-locating the server with the AI services turns each ~100ms hop
into ~15ms — the single biggest lever we control.

**Hard constraint: the DB must be local to the media server.** The fast-path does
several Postgres reads per turn at ~1ms today. A remote DB (~100–200ms/read)
would destroy the fast-path. So the media server **and** Postgres move together.

**Hard constraint: ElevenLabs (Sally's voice + Scribe STT realtime) is US-only.**
This is what makes "multi-region" subtle — see §7. The lowest-latency design is a
single region **co-located with ElevenLabs + Anthropic + a Twilio media edge**,
i.e. the US east coast.

---

## 2. Current architecture (what moves)

- `apps/voice` — Fastify + WebSocket media server (Twilio Media Streams ⇄ our
  μ-law codec/VAD ⇄ ElevenLabs Scribe STT + Sally TTS ⇄ OrderAgent/fast-path +
  Anthropic). Latency-critical. **Already containerized** (`apps/voice/Dockerfile`,
  node 22 alpine, `:8080`, healthcheck; comment already targets Fly/Render/Railway).
- `apps/web` — Next.js admin/kitchen/POS/customer + `/api`. Staff-facing (Perth).
  Already containerized (`apps/web/Dockerfile`).
- Postgres 16 — shared state (orders, menu, calls, inventory, payments).
  `docker-compose.yml` today; loopback `:5441` on the Windows box.
- SMS worker + maintenance worker — run inside the voice process.
- Cloudflare tunnel (`infra/cloudflared`) → exposes the box; watchdog scheduled
  tasks (`infra/*.ps1`) keep it alive. **Both retired by the cloud move.**
- Twilio number **+61455500004** → Voice webhook `…/twilio/voice`.

---

## 3. Recommended target — Phase 1: single US region

Two viable hosts. **Fly.io recommended** (the Dockerfile already targets it;
WebSocket-native; global regions; managed Postgres; fastest to ship). AWS is the
enterprise alternative if Kevin wants it on his existing AWS.

### Option A — Fly.io (recommended, ~1–2 days to stand up)
- App `meatbox-voice` in region **`iad`** (Ashburn, US-east) — next to
  ElevenLabs, Anthropic, and a major Twilio media edge. 2+ machines, autoscale.
- App `meatbox-web` in `iad` (or Vercel).
- **Fly Postgres** in `iad`, co-located → fast-path reads stay ~1–5ms.
- Fly gives TLS + a stable hostname + anycast routing; WebSockets work natively.
- `fly deploy` from the existing Dockerfiles; secrets via `fly secrets`.

### Option B — AWS (Kevin's account, ~3–5 days)
- **us-east-1**. Media server on ECS Fargate behind an ALB (WebSocket + TLS),
  2+ tasks, target-tracking autoscale. Web on ECS or Vercel.
- **RDS Postgres** (db.t4g.small; Multi-AZ optional) in us-east-1.
- Secrets Manager; CloudWatch alarms; ECR for images; Terraform for all of it.

### Common to both
- Point the Twilio number's **Voice edge / Media Streams region to `ashburn`
  (us-east)** so caller media ingests near the server and rides Twilio's backbone.
- Retire the Cloudflare tunnel + Windows watchdog (managed health checks +
  auto-restart replace them).
- **Rotate every secret during migration** (the Anthropic + ElevenLabs keys were
  pasted in chat and must be rotated regardless).
- Keep the Sydney box as a **hot fallback** for the first week (DNS/Voice-URL
  revert in minutes).

---

## 4. Latency: before → after (estimates, per reply)

| Turn type | Now (Sydney box) | After (US, co-located) |
|-----------|------------------|------------------------|
| Cached phrase (greeting, "anything else?", base/sauce Q) | ~0 (already) | ~0 |
| Fast-path option/name (probe hit) | ~5–30ms | ~5–30ms |
| First item / probe-miss (STT round-trip) | ~400ms | **~280ms** |
| Understanding turn (Haiku) | ~1.2s | **~1.0–1.1s** |
| Total-only close (live TTS) | ~800ms | **~450–550ms** |

Plus the caller→server leg (mouth-to-ear), which the cloud move changes by
*where* the caller is:
- **US callers:** near-zero added — big win.
- **Perth callers (the real customers):** roughly neutral vs today (Twilio
  backbone AU→US replaces the AU-box→US-AI hops) — ~modest net gain.
- **India (Kevin's testing):** likely **faster and far more reliable** — Twilio's
  managed India→US routing avoids the carrier India→AU drops he keeps hitting.

Net: consistent, production-grade latency for callers **anywhere**, the geographic
tax cut from ~100ms to ~15ms per AI round-trip, and the connection drops gone.

---

## 5. Phases

- **Phase 0 — Prep (no downtime):** finalize prod Dockerfiles, add IaC
  (fly.toml / Terraform), CI to build+push images, provision managed Postgres,
  load schema (migrations already run on boot), move secrets to the secret store.
- **Phase 1 — Parallel stand-up:** deploy voice+web+DB in US; point a **TEST**
  Twilio number at it; run the robot + real-call battery; compare felt-gap
  telemetry (already recorded in `call_events`) against the Sydney box.
- **Phase 2 — Cutover:** migrate data (pg_dump/restore), switch +61455500004
  Voice URL to the cloud endpoint, watch live; Sydney box stays hot as fallback.
- **Phase 3 — Harden:** autoscaling, alarms, automated backups, log aggregation,
  a status/health dashboard.
- **Phase 4 (optional) — true multi-region:** only if non-US call volume grows
  (see §7).

---

## 6. Rough cost (low volume, monthly)

| Item | Fly.io | AWS |
|------|--------|-----|
| Voice server (2 small machines/tasks) | ~$30–50 | ~$40–70 |
| Web | ~$15–30 (or Vercel free/pro) | ~$20–40 |
| Managed Postgres | ~$25–50 | ~$30–70 (Multi-AZ more) |
| LB / TLS / egress / secrets / logs | included-ish | ~$40–60 |
| **Infra total** | **~$80–150/mo** | **~$130–240/mo** |

Twilio (per-minute) and ElevenLabs/Anthropic (per-usage) are unchanged. Today the
box costs $0 in infra but carries the reliability + latency ceiling.

---

## 7. True multi-region voice layer (Phase 2 — Kevin is open to it)

Running media servers in multiple regions only helps if the STT/TTS is ALSO
regional. ElevenLabs (Sally) is US-only, so Phase 1 keeps a single US region.
For genuinely-local speed worldwide, Phase 2 pilots a multi-region voice layer.
Research (Sept 2026):

- **TTS — Cartesia (Sonic-3):** ~50–90ms time-to-first-audio (vs ElevenLabs
  flash ~300ms), built for realtime phone agents, **APAC presence**, and
  **voice cloning** — so we can re-create a Sally-like voice regionally. This is
  the standout: faster AND regional. (Alternatives: PlayHT WebSocket TTS w/
  30-sec cloning; Rime for conversational cloning.)
- **STT — Deepgram (Flux):** multi-region, sub-300ms, cost-efficient at scale.
  (ElevenLabs Scribe v2 realtime is ~150ms first-partial but US-only.)
- **LLM — Anthropic via Bedrock/Vertex** in a regional zone (Sydney available),
  so understanding turns also run near a regional media server.

The pipeline is provider-agnostic by design (our `elevenlabs-stream.ts` is a thin
adapter — swapping in Cartesia/Deepgram is an adapter change, not a rewrite), so
Phase 2 is additive. **Mandatory before committing:** clone Sally on Cartesia,
run a same-region P50/P90 latency test on our own audio, and let Kevin ear-test
the cloned voice — vendor latency claims are a shortlist filter, not proof.

Phase 2 outcome if it lands: media servers in `iad` (US) + `syd` (APAC) +
optionally `lhr` (EU), each with region-local Cartesia/Deepgram/Anthropic → every
caller hits a nearby stack, geographic tax ~15ms everywhere. This is the actual
"worldwide, no lag" target.

---

## 8. Decisions needed from Kevin

1. **Host:** Fly.io (recommended, fastest) vs AWS (your account, enterprise).
2. **Who owns the cloud account + billing** — you provision/authorize; I build.
3. **Acceptable monthly infra spend** (see §6).
4. **Keep Sally (US-bound) vs open to a multi-region voice vendor** for true
   global speed later.
5. **Cutover window** — plan is near-zero downtime via parallel stand-up.

## 9. Split of work

- **I build:** prod Dockerfiles/IaC, CI, DB migration scripts, deploy, Twilio
  edge config, the test battery, the cutover, hardening.
- **You provide:** the cloud account + billing authorization, the spend approval,
  the vendor decisions above. (DNS is already on Cloudflare — no change needed.)

## 10a. Kevin's setup steps (unblocks the build — ~15 min)

I can't create accounts or enter payment. To unblock Phase 1:
1. Create a Fly.io account at fly.io and add a card (billing).
2. Install flyctl and sign in, OR create a deploy token and give it to me:
   `fly tokens create deploy -x 999999h` (paste it to me — I'll treat it as a
   secret and we rotate it after).
3. Tell me your ElevenLabs + Anthropic keys are OK to move (we rotate both
   during migration since they were pasted in chat).
That's it — I do the rest (Postgres, deploy, Twilio edge, test battery, cutover).

Already prepared in the repo (account-independent): `fly.voice.toml`,
`fly.web.toml`, production Dockerfiles, boot-time migrations.

## 10. Honest expectation

This makes the system production-grade and **consistent worldwide**, removes the
Windows-box reliability ceiling, and cuts the geographic tax to ~15ms/round-trip.
It will **not** make replies literally instant — the AI still thinks (~1s on
ambiguous turns) and audio still travels. Combined with what already shipped
(fast-path + Sally audio cache + partial probe + Haiku), ordering turns stay
gapless and understanding turns settle at ~1s for callers anywhere.
