import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {
  createAnthropicLlm,
  env,
  getDb,
  getDefaultRestaurant,
  getSettings,
  listItems,
  runMigrations,
} from "@meatbox/core";
import { conversationRelayTwiml, unavailableTwiml } from "./twiml";
import { validateTwilioSignature, verifyRelayToken } from "./twilio-signature";
import { RelaySession } from "./relay-session";
import { startSmsWorker } from "./sms-worker";
import { createSimulatorSession, simulatorTurn } from "./simulator";

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
    smsMode: env.SMS_MODE,
  };
});

// ------------------------------------------------------------ Twilio webhooks

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
      req.log.warn("invalid Twilio signature on /twilio/voice");
      return reply.code(403).send("forbidden");
    }
  } else {
    req.log.warn("TWILIO_AUTH_TOKEN not set — skipping signature validation (dev only)");
  }

  const callSid = params.CallSid ?? "";
  reply.type("text/xml");
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

// ------------------------------------------------------------ boot

await runMigrations(getDb());
const smsWorker = startSmsWorker((msg) => app.log.info(msg));

const shutdown = async () => {
  smsWorker.stop();
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
