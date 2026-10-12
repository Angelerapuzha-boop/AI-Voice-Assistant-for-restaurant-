import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {
  createAnthropicLlm,
  CEKURA_TEST_CALLERS,
  env,
  getDb,
  getDefaultRestaurant,
  getModifierGroups,
  getSettings,
  groupQuestion,
  listOptions,
  listItems,
  runMigrations,
  settlePayment,
  SquareTerminalProvider,
  getSquareConnection,
  ConversationalReservationBrain,
  ReservationMachine,
} from "@meatbox/core";
import { warmPhrases, warmFixed } from "./tts-cache";
import { activeVoiceId } from "./voice-providers";
import { conversationRelayTwiml, elevenLabsSipTwiml, mediaStreamTwiml, unavailableTwiml } from "./twiml";
import { validateTwilioSignature, verifyRelayToken } from "./twilio-signature";
import { RelaySession } from "./relay-session";
import { AI_FILLERS, MediaStreamSession } from "./media-stream-session";
import { ChirpSession } from "./chirp-session";
import { checkBridgeSecret, ElevenLabsBridge, verifyPostCallSignature } from "./elevenlabs-bridge";
import { startMaintenanceWorker, startSmsWorker } from "./sms-worker";
import { createSimulatorSession, simulatorTurn } from "./simulator";

// A phone service must never die silently mid-call: log the fault loudly.
// An uncaught exception exits (the watchdog restarts within seconds);
// an unhandled rejection is logged and survived.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] uncaught exception, exiting for watchdog restart:", err);
  process.exit(1);
});

const app = Fastify({
  logger: { level: "info" },
});

await app.register(websocket);

function publicUrl(path: string): string {
  return `${env.VOICE_PUBLIC_URL.replace(/\/$/, "")}${path}`;
}

// ------------------------------------------------------------ health

app.get("/health", async () => {
  let dbOk = false;
  try {
    await getDb().query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return {
    ok: dbOk,
    db: dbOk,
    anthropicConfigured: Boolean(env.ANTHROPIC_API_KEY),
    twilioConfigured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
    elevenLabsBridge: Boolean(env.ELEVENLABS_BRIDGE_SECRET),
    smsMode: env.SMS_MODE,
  };
});

// ------------------------------------------------------------ ElevenLabs Agents bridge

const elevenLabsBridge = new ElevenLabsBridge({
  log: (msg, extra) => app.log.info(extra ?? {}, msg),
});

app.post("/elevenlabs/call-init", async (req, reply) => {
  if (!checkBridgeSecret(req.headers["x-bridge-secret"] as string | undefined)) {
    return reply.code(401).send({ error: "unauthorised" });
  }
  return elevenLabsBridge
    .handleInit((req.body ?? {}) as Record<string, unknown>)
    .then((r) => reply.code(r.status).send(r.body));
});

app.post("/elevenlabs/tools/:name", async (req, reply) => {
  if (!checkBridgeSecret(req.headers["x-bridge-secret"] as string | undefined)) {
    return reply.code(401).send({ error: "unauthorised" });
  }
  const name = (req.params as { name: string }).name;
  const r = await elevenLabsBridge.handleTool(name, (req.body ?? {}) as Record<string, unknown>);
  return reply.code(r.status).send(r.body);
});

// Post-call transcripts arrive HMAC-signed over the raw body, so this route
// lives in a scope with an unparsed JSON body (same pattern as Square).
await app.register(async (scope) => {
  scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });
  scope.post("/elevenlabs/post-call", async (req, reply) => {
    const rawBody = typeof req.body === "string" ? req.body : "";
    const signed = verifyPostCallSignature(
      rawBody,
      req.headers["elevenlabs-signature"] as string | undefined,
    );
    const secretOk = checkBridgeSecret(req.headers["x-bridge-secret"] as string | undefined);
    if (!signed && !secretOk) return reply.code(401).send({ error: "unauthorised" });
    const r = await elevenLabsBridge.handlePostCall(rawBody);
    return reply.code(r.status).send(r.body);
  });
});

// Safety net for missed post-call webhooks: finalise idle sessions.
const bridgeSweep = setInterval(() => {
  void elevenLabsBridge.sweep().catch((err) => app.log.warn({ err }, "elevenlabs sweep failed"));
}, 60_000);
bridgeSweep.unref();

// ------------------------------------------------------------ Twilio webhooks

// Callers whose INBOUND calls we record — TEST numbers only (they consent to
// their own test calls, so no third-party-consent issue). Real customers are
// NEVER recorded here. Kevin 2026-09-29: record the +61455500003 test handset.
const RECORD_INBOUND_CALLERS = new Set(
  (process.env.RECORD_INBOUND_CALLERS ??
    // Kevin's own test handsets (they consent). The robot number +15550000005
    // is excluded — its outbound leg already self-records, so listing it would
    // double-record.
    "+61455500003,+61455500001,+61455500002")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Record EVERY inbound call, not just the test list. Off by default. Recording
// real customers can require a "this call may be recorded" announcement (AU
// two-party consent), so enable this only where that's handled or on a test box.
const RECORD_ALL_INBOUND = (process.env.RECORD_ALL_INBOUND ?? "").toLowerCase() === "true";

/** Start a dual-channel recording on an in-progress call via the Twilio REST
 * API. Fire-and-forget from the voice webhook (the call is already answered).
 * Used only for whitelisted TEST callers. */
async function startCallRecording(callSid: string): Promise<void> {
  if (!callSid || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;
  const auth =
    "Basic " + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`,
    {
      method: "POST",
      headers: { Authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ RecordingChannels: "dual", RecordingTrack: "both" }),
    },
  );
  if (!res.ok) throw new Error(`recording start ${res.status}: ${await res.text()}`);
}

app.post("/twilio/voice", async (req, reply) => {
  const params = (req.body ?? {}) as Record<string, string>;
  if (env.TWILIO_AUTH_TOKEN) {
    const ok = validateTwilioSignature(
      env.TWILIO_AUTH_TOKEN,
      req.headers["x-twilio-signature"] as string | undefined,
      publicUrl("/twilio/voice"),
      params,
    );
    if (!ok) {
      // Diagnostics for the intermittent 403s seen 2026-09-11: log which
      // params the request carried (names only) so the failing variant
      // (e.g. a Twilio retry with extra fields) becomes identifiable.
      req.log.warn(
        {
          paramKeys: Object.keys(params).sort().join(","),
          hasSignature: Boolean(req.headers["x-twilio-signature"]),
          callSid: params.CallSid ?? "",
          callStatus: params.CallStatus ?? "",
        },
        "invalid Twilio signature on /twilio/voice",
      );
      return reply.code(403).send("forbidden");
    }
  } else {
    req.log.warn("TWILIO_AUTH_TOKEN not set — skipping signature validation (dev only)");
  }

  const callSid = params.CallSid ?? "";
  reply.type("text/xml");
  // Custom media-stream pipeline: our own audio + Sally at fast-path speed.
  if (env.VOICE_STACK === "custom") {
   try {
    // TEMP test routing (2026-09-17): the owner's own phones are sent to the
    // us-east-1 cloud box for live testing; every real customer stays on this
    // (Sydney) box. A non-matching number defaults to Sydney. Remove after cutover.
    // Cekura external voice-testing numbers (CEKURA_TEST_CALLERS env) are merged
    // in so Cekura's calls reach the reservation box; they're tagged cekura_test.
    const TEST_CLOUD_CALLERS = new Set([
      "+61455500001",
      "+61455500002",
      "+15550000005",
      ...CEKURA_TEST_CALLERS,
    ]);
    // Sydney (ap-southeast-2) all-Australian box: Olivia (Polly) + Transcribe.
    // Env override so the target can change (quick tunnel -> stable) without a
    // code edit; falls back to the current AU quick tunnel.
    const TEST_CLOUD_WSS =
      env.TEST_CLOUD_WSS || "https://bouquet-beast-contain-exposed.trycloudflare.com";
    // Cekura external voice-testing arrives over SIP (via a dedicated Twilio SIP
    // domain) and self-identifies by the X-Run/Scenario/Result-Id headers Cekura
    // injects — Twilio surfaces SIP headers as `SipHeader_*` body params. These
    // calls always go to the reservation box and are tagged source=cekura_test,
    // regardless of the (SIP) caller ID. (CEKURA_TEST_CALLERS covers any pool
    // caller ID too, for completeness.)
    const isCekuraSip = Object.keys(params).some((k) =>
      /^SipHeader_X-(Run|Scenario|Result)-Id$/i.test(k),
    );
    const isCekuraTest = isCekuraSip || CEKURA_TEST_CALLERS.has(params.From ?? "");
    const toCloud = isCekuraTest || TEST_CLOUD_CALLERS.has(params.From ?? "");
    const wssBase = toCloud ? TEST_CLOUD_WSS : env.VOICE_PUBLIC_URL;
    const source = isCekuraTest ? "cekura_test" : undefined;
    // Record TEST callers' own calls (consented) so Kevin has audio — started
    // here on the parent call, so it captures the audio whether it streams to
    // prod or the box. Fire-and-forget; never blocks the TwiML. Never real customers.
    if (RECORD_ALL_INBOUND || RECORD_INBOUND_CALLERS.has(params.From ?? "")) {
      startCallRecording(callSid).catch((err) =>
        req.log.warn({ err: String(err), callSid }, "failed to start inbound recording"),
      );
    }
    req.log.info(
      { callSid, routedTo: toCloud ? "cloud-test" : "sydney", cekuraTest: isCekuraTest },
      "routing call to custom media-stream pipeline",
    );
    return mediaStreamTwiml({ wssBase, from: params.From ?? "", source });
   } catch (err) {
     // An unexpected error must never 500 an INBOUND call — return valid TwiML so
     // the caller hears a brief apology instead of Twilio's error tone.
     req.log.error({ err: String(err), callSid }, "custom voice webhook failed");
     return unavailableTwiml("Sorry, we can't take your call right now. Please try again in a few minutes.");
   }
  }
  // ElevenLabs stack: hand the call to the hosted agent over SIP. The
  // Dial action falls back to the relay stack if the SIP leg fails.
  if (env.VOICE_STACK === "elevenlabs" && env.TWILIO_PHONE_NUMBER) {
    req.log.info({ callSid }, "routing call to ElevenLabs agent via SIP");
    return elevenLabsSipTwiml({
      number: env.TWILIO_PHONE_NUMBER,
      actionPath: publicUrl("/twilio/sip-result"),
    });
  }
  try {
    const db = getDb();
    const restaurant = await getDefaultRestaurant(db);
    const settings = await getSettings(db, restaurant.id);
    if (!env.ANTHROPIC_API_KEY) {
      return unavailableTwiml(
        "Sorry, our ordering assistant is unavailable right now. Please call back shortly.",
      );
    }
    // Menu item names become speech hints so STT hears "Gozleme" correctly.
    const items = await listItems(db, restaurant.id);
    const extraHints = items.map((i) => i.name);
    return conversationRelayTwiml({ settings, callSid, speechHintsExtra: extraHints });
  } catch (err) {
    req.log.error({ err }, "voice webhook failed");
    return unavailableTwiml(
      "Sorry, we can't take your call right now. Please try again in a few minutes.",
    );
  }
});

// Dial-action after the SIP handoff: a completed SIP leg just ends; a
// failed one (ElevenLabs unreachable) falls back to the relay stack so
// the caller still gets served on the same call.
app.post("/twilio/sip-result", async (req, reply) => {
  const params = (req.body ?? {}) as Record<string, string>;
  if (env.TWILIO_AUTH_TOKEN) {
    const ok = validateTwilioSignature(
      env.TWILIO_AUTH_TOKEN,
      req.headers["x-twilio-signature"] as string | undefined,
      publicUrl("/twilio/sip-result"),
      params,
    );
    if (!ok) return reply.code(403).send("forbidden");
  }
  reply.type("text/xml");
  const status = params.DialCallStatus ?? "";
  if (status === "completed" || status === "answered") {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>`;
  }
  req.log.warn({ callSid: params.CallSid, status }, "SIP handoff failed — falling back to relay");
  try {
    const db = getDb();
    const restaurant = await getDefaultRestaurant(db);
    const settings = await getSettings(db, restaurant.id);
    const items = await listItems(db, restaurant.id);
    return conversationRelayTwiml({
      settings,
      callSid: params.CallSid ?? "",
      speechHintsExtra: items.map((i) => i.name),
    });
  } catch (err) {
    req.log.error({ err }, "sip fallback failed");
    return unavailableTwiml(
      "Sorry, we can't take your call right now. Please try again in a few minutes.",
    );
  }
});

app.post("/twilio/sms-status", async (req, reply) => {
  const params = (req.body ?? {}) as Record<string, string>;
  if (env.TWILIO_AUTH_TOKEN) {
    const ok = validateTwilioSignature(
      env.TWILIO_AUTH_TOKEN,
      req.headers["x-twilio-signature"] as string | undefined,
      publicUrl("/twilio/sms-status"),
      params,
    );
    if (!ok) return reply.code(403).send("forbidden");
  }
  const sid = params.MessageSid ?? params.SmsSid;
  const status = params.MessageStatus ?? params.SmsStatus ?? "";
  if (sid && status) {
    // Idempotent: repeated/out-of-order callbacks just re-write the field;
    // delivered_at is only ever set once.
    await getDb().query(
      `UPDATE notification_attempts
       SET delivery_status = $2,
           delivered_at = CASE WHEN $2 = 'delivered' AND delivered_at IS NULL THEN now() ELSE delivered_at END,
           last_error = CASE WHEN $3 <> '' THEN 'twilio error ' || $3 ELSE last_error END
       WHERE provider_sid = $1`,
      [sid, status, params.ErrorCode ?? ""],
    );
  }
  return "ok";
});

app.post("/twilio/status", async (req) => {
  // Call status callbacks are informational; call rows are finalised by the
  // relay session itself. Log for observability.
  const params = (req.body ?? {}) as Record<string, string>;
  req.log.info({ callSid: params.CallSid, status: params.CallStatus }, "twilio status");
  return "ok";
});

// ------------------------------------------------------------ ConversationRelay WS

app.get("/twilio/relay", { websocket: true }, (socket, req) => {
  const token = (req.query as Record<string, string>).token ?? "";
  new RelaySession(socket, {
    createLlm: (model) => createAnthropicLlm(model),
    verifyToken: (callSid, t) =>
      verifyRelayToken(env.INTERNAL_API_SECRET || "dev-secret", callSid, t),
    token,
    log: (msg, extra) => req.log.warn(extra ?? {}, msg),
  });
});

// ------------------------------------------------------------ custom media stream WS

app.get("/twilio/media", { websocket: true }, (socket, req) => {
  // A failure building the session must never throw out of the WS handler (that
  // could take the process down mid-call for everyone). Close this socket cleanly
  // and survive (Kevin 2026-10-06: both inbound & outbound must not crash).
  try {
    new MediaStreamSession(socket, {
      createLlm: (model) => createAnthropicLlm(model),
      log: (msg, extra) => req.log.info(extra ?? {}, msg),
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "failed to start media session");
    try { socket.close(); } catch { /* noop */ }
  }
});

// Cekura external voice-testing transport (raw-PCM 16 kHz WebSocket / CHIRP).
// Guarded by Basic Auth (CEKURA_CHIRP_AUTH="user:pass"); disabled when unset.
app.get("/cekura/chirp", { websocket: true }, (socket, req) => {
  const configured = env.CEKURA_CHIRP_AUTH;
  const expected = configured ? "Basic " + Buffer.from(configured).toString("base64") : "";
  const got = (req.headers["authorization"] as string | undefined) ?? "";
  if (!configured || got !== expected) {
    req.log.warn({ hasAuth: Boolean(got) }, "cekura chirp: rejected (auth)");
    try {
      socket.close(1008, "unauthorized");
    } catch {
      /* already closed */
    }
    return;
  }
  new ChirpSession(socket, { log: (msg, extra) => req.log.info(extra ?? {}, msg) });
});

// ------------------------------------------------------------ simulator (internal)

function checkInternalSecret(req: { headers: Record<string, unknown> }): boolean {
  const header = req.headers["x-internal-secret"];
  return Boolean(env.INTERNAL_API_SECRET) && header === env.INTERNAL_API_SECRET;
}

app.post("/simulator/session", async (req, reply) => {
  if (!checkInternalSecret(req)) return reply.code(401).send({ error: "unauthorised" });
  if (!env.ANTHROPIC_API_KEY) {
    return reply.code(503).send({
      error: "ANTHROPIC_API_KEY is not configured — add it to .env to test the AI.",
    });
  }
  try {
    return await createSimulatorSession((model) => createAnthropicLlm(model));
  } catch (err) {
    req.log.error({ err }, "simulator session failed");
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.post("/simulator/message", async (req, reply) => {
  if (!checkInternalSecret(req)) return reply.code(401).send({ error: "unauthorised" });
  const body = (req.body ?? {}) as { sessionId?: string; text?: string };
  if (!body.sessionId || !body.text) {
    return reply.code(400).send({ error: "sessionId and text are required" });
  }
  try {
    return await simulatorTurn(body.sessionId, body.text);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ------------------------------------------------------------ Square payments webhook

/**
 * Terminal checkout callbacks (Phase 3). Signature-verified against the raw
 * body; settlement is idempotent, so Square's duplicate/out-of-order
 * deliveries are harmless. Inert until SQUARE_WEBHOOK_SIGNATURE_KEY is set.
 */
await app.register(async (scope) => {
  scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });
  scope.post("/payments/webhook/square", async (req, reply) => {
    if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) return reply.code(404).send({ error: "not configured" });
    const db = getDb();
    const restaurant = await getDefaultRestaurant(db);
    const conn = await getSquareConnection(db, restaurant.id);
    if (!conn) return reply.code(404).send({ error: "not connected" });
    const provider = new SquareTerminalProvider(conn, env.SQUARE_TERMINAL_DEVICE_ID);
    const parsed = provider.verifyAndParseWebhook({
      signature: (req.headers["x-square-hmacsha256-signature"] as string | undefined) ?? "",
      rawBody: typeof req.body === "string" ? req.body : "",
      notificationUrl: publicUrl("/payments/webhook/square"),
    });
    if (!parsed.valid) {
      req.log.warn("invalid Square webhook signature");
      return reply.code(403).send({ error: "bad signature" });
    }
    for (const event of parsed.events) {
      if (event.status === "pending") continue;
      await settlePayment(db, {
        providerPaymentId: event.providerPaymentId,
        outcome: event.status,
        settlementId: event.settlementId,
      });
    }
    return { ok: true };
  });
});

// ------------------------------------------------------------ boot

await runMigrations(getDb());
const smsWorker = startSmsWorker((msg) => app.log.info(msg));
const maintenanceWorker = startMaintenanceWorker((msg) => app.log.info(msg));

// Pre-synthesise Sally's invariant fast-path phrases (greeting, "Anything
// else?", the name question, every required-option question) so they replay
// instantly from cache on the very first call. Custom stack only; disk-cached,
// so this is a no-op after the first warm. Fire-and-forget — never blocks boot.
async function warmTtsCacheAtBoot(): Promise<void> {
  if (env.VOICE_STACK !== "custom" || !env.ELEVENLABS_API_KEY) return;
  const db = getDb();
  const restaurant = await getDefaultRestaurant(db);
  const settings = await getSettings(db, restaurant.id);
  // Reservations mode: pre-synthesise the FIXED greeting + close lines so the very
  // first words of every call play instantly from cache instead of a per-call
  // ElevenLabs round-trip (the start/end lag Kevin reported 2026-10-07). These are
  // long (>80 chars) so they need warmFixed, which bypasses the length guard.
  if (env.BUSINESS_MODE === "reservations") {
    // Warm BOTH brains' fixed lines (they share the greetings) so instant playout
    // holds whether a call runs the deterministic or the LLM brain.
    const fixed = [...new Set([
      ...ReservationMachine.fixedSpeech(restaurant.name),
      ...ConversationalReservationBrain.fixedSpeech(restaurant.name),
    ])];
    await warmFixed(activeVoiceId(), fixed, (m) => app.log.info(m));
    return;
  }
  const phrases = new Set<string>([
    "Anything else?",
    "Done. Anything else?",
    "What name shall I put it under?",
    "What can I get for you?",
    "No worries, I've cleared that. What else can I get you?",
    ...AI_FILLERS, // the rotated fillers, spoken only on a genuine (rare) LLM turn
    "Yep.",
  ]);
  if (settings.aiGreeting) phrases.add(settings.aiGreeting);
  const items = await listItems(db, restaurant.id);
  for (const item of items) {
    const groups = await getModifierGroups(db, item.id);
    for (const g of groups) {
      const opts = g.modifiers.filter((m) => m.isAvailable).map((m) => m.name);
      phrases.add(groupQuestion(g.name, opts));
      // The "what have you got?" read-back of the same group, so it replays
      // instantly too.
      phrases.add(listOptions(opts));
    }
  }
  await warmPhrases(activeVoiceId(), [...phrases], (m) => app.log.info(m));
}
void warmTtsCacheAtBoot().catch((err) => app.log.warn({ err }, "tts cache warm failed"));

const shutdown = async () => {
  smsWorker.stop();
  maintenanceWorker.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

app.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  },
);

await app.listen({ host: env.HOST, port: env.VOICE_PORT });
app.log.info(`Meatbox voice service on ${env.HOST}:${env.VOICE_PORT} (sms=${env.SMS_MODE})`);
