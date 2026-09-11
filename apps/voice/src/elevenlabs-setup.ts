/**
 * One-shot (idempotent) provisioning of the ElevenLabs agent that fronts
 * the Meatbox order engine. Creates/updates, never duplicates:
 *   1. a workspace secret carrying the bridge auth header,
 *   2. one webhook tool per order-engine tool (schemas from TOOL_DEFS),
 *   3. the agent itself: persona prompt, Alice voice, restaurant ambience,
 *      per-call prompt overrides + conversation-initiation webhook.
 *
 * Run:   pnpm --filter @meatbox/voice exec tsx src/elevenlabs-setup.ts
 * Flags: --with-phone   ALSO imports the Twilio number and points its
 *                       INBOUND VOICE at the agent (THE LIVE CUTOVER —
 *                       only run once a test call has been verified).
 *
 * Needs in .env: ELEVENLABS_API_KEY, ELEVENLABS_BRIDGE_SECRET, and a
 * public VOICE_PUBLIC_URL. Prints the agent id — put it in .env as
 * ELEVENLABS_AGENT_ID so re-runs update instead of creating.
 */
import {
  buildMenuCatalog,
  buildSystemPrompt,
  closeDb,
  env,
  getDb,
  getDefaultRestaurant,
  getHours,
  getSettings,
  listItems,
  TOOL_DEFS,
  type LlmToolDef,
} from "@meatbox/core";
import { ELEVENLABS_PROMPT_APPENDIX } from "./elevenlabs-bridge";

const API = "https://api.elevenlabs.io";
const AGENT_NAME = "Meatbox WA — Phone Orders";
const SECRET_NAME = "meatbox-bridge-secret";

// end_call is the platform's built-in hang-up; create_order_draft happens
// automatically inside the bridge's add_order_item (first-turn latency);
// the others are covered by the in-prompt menu catalog and only add
// tool-choice latency.
const EXCLUDED_TOOLS = new Set([
  "end_call",
  "create_order_draft",
  "get_menu_category",
  "get_available_modifiers",
  "check_item_availability",
  "calculate_order_total",
]);

// Mutating tools carry webhook latency the caller can hear — force a
// short spoken ack ("Yep.") before the request goes out.
const PRE_SPEECH_TOOLS = new Set([
  "add_order_item",
  "update_order_item",
  "remove_order_item",
  "repeat_last_order",
  "confirm_order",
  "set_order_details",
]);

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    console.error(`  ${method} ${path} -> ${res.status}`);
    console.error(`  ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);
  }
  return { ok: res.ok, status: res.status, data };
}

/** "menuItemId" -> "menu item id" — fallback description for bare params. */
function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * ElevenLabs accepts a JSON-Schema subset and REQUIRES every property to
 * carry a description (or dynamic_variable/constant_value); strip what it
 * rejects and fill missing descriptions from the property name.
 */
function sanitizeSchema(schema: Record<string, unknown>, keyName?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = sanitizeSchema(schema.items as Record<string, unknown>, "value");
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(
        ([k, v]) => [k, sanitizeSchema(v, k)],
      ),
    );
  }
  if (schema.required) out.required = schema.required;
  if (!out.description && keyName) out.description = humanize(keyName);
  return out;
}

function webhookToolConfig(def: LlmToolDef, authHeader: unknown): Record<string, unknown> {
  const base = sanitizeSchema(def.input_schema as unknown as Record<string, unknown>);
  const properties = { ...((base.properties as Record<string, unknown>) ?? {}) };
  const required = [...((base.required as string[]) ?? [])];
  // Session routing: the platform fills the conversation id in itself.
  properties.conversation_id = {
    type: "string",
    dynamic_variable: "system__conversation_id",
  };
  required.push("conversation_id");
  if (def.name === "confirm_order") {
    properties.caller_final_words = {
      type: "string",
      description:
        "The caller's EXACT latest words agreeing to the order (e.g. 'yep', 'yes lock it in'). Quote verbatim — never paraphrase or invent.",
    };
    required.push("caller_final_words");
  }
  return {
    type: "webhook",
    name: def.name,
    description: def.description,
    response_timeout_secs: 15,
    pre_tool_speech: PRE_SPEECH_TOOLS.has(def.name) ? "force" : "auto",
    api_schema: {
      url: `${env.VOICE_PUBLIC_URL.replace(/\/$/, "")}/elevenlabs/tools/${def.name}`,
      method: "POST",
      request_headers: { "x-bridge-secret": authHeader },
      request_body_schema: { type: "object", properties, required },
    },
  };
}

async function main(): Promise<void> {
  const withPhone = process.argv.includes("--with-phone");
  if (!env.ELEVENLABS_API_KEY) fail("ELEVENLABS_API_KEY is not set in .env");
  if (!env.ELEVENLABS_BRIDGE_SECRET) fail("ELEVENLABS_BRIDGE_SECRET is not set in .env");
  if (!/^https:\/\//.test(env.VOICE_PUBLIC_URL)) {
    fail(`VOICE_PUBLIC_URL must be a public https URL (got: ${env.VOICE_PUBLIC_URL})`);
  }

  const db = getDb();
  const restaurant = await getDefaultRestaurant(db);
  const [settings, hours, menuCatalog, items] = await Promise.all([
    getSettings(db, restaurant.id),
    getHours(db, restaurant.id),
    buildMenuCatalog(db, restaurant.id),
    listItems(db, restaurant.id),
  ]);

  // ---------------------------------------------------------- 1. secret
  // Prefer a workspace secret for the bridge header; fall back to inline.
  let authHeader: unknown = env.ELEVENLABS_BRIDGE_SECRET;
  const secretList = await api("GET", "/v1/convai/secrets");
  if (secretList.ok) {
    const secrets = (secretList.data as { secrets?: { secret_id: string; name: string }[] })
      ?.secrets ?? [];
    let secret = secrets.find((s) => s.name === SECRET_NAME);
    if (!secret) {
      const created = await api("POST", "/v1/convai/secrets", {
        type: "new",
        name: SECRET_NAME,
        value: env.ELEVENLABS_BRIDGE_SECRET,
      });
      if (created.ok) secret = created.data as { secret_id: string; name: string };
    }
    if (secret) {
      authHeader = { secret_id: secret.secret_id };
      console.log(`✔ workspace secret ${SECRET_NAME} (${secret.secret_id})`);
    }
  }
  if (typeof authHeader === "string") {
    console.log("! using inline header value (workspace secret unavailable)");
  }

  // ----------------------------------------------------------- 2. tools
  const wanted = TOOL_DEFS.filter((d) => !EXCLUDED_TOOLS.has(d.name));
  const toolList = await api("GET", "/v1/convai/tools");
  if (!toolList.ok) fail("could not list tools — is the API key valid?");
  const existing = new Map(
    ((toolList.data as { tools?: { id: string; tool_config: { name: string } }[] })?.tools ?? []).map(
      (t) => [t.tool_config.name, t.id],
    ),
  );
  const toolIds: string[] = [];
  for (const def of wanted) {
    const config = webhookToolConfig(def, authHeader);
    const id = existing.get(def.name);
    if (id) {
      const res = await api("PATCH", `/v1/convai/tools/${id}`, { tool_config: config });
      if (!res.ok) fail(`updating tool ${def.name} failed`);
      toolIds.push(id);
      console.log(`✔ tool ${def.name} updated (${id})`);
    } else {
      const res = await api("POST", "/v1/convai/tools", { tool_config: config });
      if (!res.ok) fail(`creating tool ${def.name} failed`);
      const newId = (res.data as { id: string }).id;
      toolIds.push(newId);
      console.log(`✔ tool ${def.name} created (${newId})`);
    }
  }

  // ----------------------------------------------------------- 3. agent
  // Stored prompt is the no-caller-ID fallback; every real call gets the
  // live per-call prompt from /elevenlabs/call-init (override enabled).
  const fallbackPrompt =
    buildSystemPrompt({ restaurant, settings, hours, now: new Date(), menuCatalog }) +
    ELEVENLABS_PROMPT_APPENDIX;

  const agentPayload = {
    name: AGENT_NAME,
    conversation_config: {
      agent: {
        first_message: settings.aiGreeting,
        language: "en",
        prompt: {
          prompt: fallbackPrompt,
          llm: env.ELEVENLABS_LLM,
          temperature: 0.3,
          tool_ids: toolIds,
          built_in_tools: {
            end_call: {
              name: "end_call",
              description: "Hang up AFTER your goodbye line has been spoken.",
              type: "system",
              params: { system_tool_type: "end_call" },
            },
          },
        },
      },
      tts: {
        // English agents must use turbo or flash v2 (platform rule).
        model_id: "eleven_turbo_v2",
        voice_id: env.ELEVENLABS_VOICE_ID,
        // Clarity on an 8kHz phone line: steadier delivery, stronger voice
        // presence, fractionally slower speech.
        stability: 0.65,
        similarity_boost: 0.9,
        speed: 0.97,
      },
      asr: {
        quality: "high",
        keywords: items.map((i) => i.name).slice(0, 80),
      },
      turn: {
        turn_timeout: 7,
        // Eager: respond the moment the caller stops — "no silence" spec.
        turn_eagerness: "eager",
        // Any slow generation gets spoken cover instead of dead air.
        soft_timeout_config: {
          timeout_seconds: 3,
          message: "Just a sec.",
          use_llm_generated_message: false,
          max_soft_timeouts_per_generation: 1,
        },
      },
      conversation: {
        max_duration_seconds: 480,
        // Kevin's spec: continuous restaurant atmosphere "as a feel, not a
        // disturbance" — native platform mixing, low volume, seamless loop.
        background_sound: {
          source_type: "preset",
          source_id: "restaurant",
          // Sally is a soft voice — ambience stays a distant "feel",
          // clearly UNDER the voice on a compressed phone line.
          volume: 0.04,
          crossfade_loop: true,
        },
      },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: false },
          tts: { voice_id: false },
        },
        enable_conversation_initiation_client_data_from_webhook: true,
      },
      workspace_overrides: {
        conversation_initiation_client_data_webhook: {
          url: `${env.VOICE_PUBLIC_URL.replace(/\/$/, "")}/elevenlabs/call-init`,
          request_headers: { "x-bridge-secret": authHeader },
        },
      },
    },
  };

  let agentId = env.ELEVENLABS_AGENT_ID;
  if (!agentId) {
    // Guard against duplicates from a lost .env entry: match by name.
    const list = await api("GET", "/v1/convai/agents?page_size=100");
    const found = (
      (list.data as { agents?: { agent_id: string; name: string }[] })?.agents ?? []
    ).find((a) => a.name === AGENT_NAME);
    if (found) agentId = found.agent_id;
  }
  if (agentId) {
    const res = await api("PATCH", `/v1/convai/agents/${agentId}`, agentPayload);
    if (!res.ok) fail("updating the agent failed");
    console.log(`✔ agent updated (${agentId})`);
  } else {
    const res = await api("POST", "/v1/convai/agents/create", agentPayload);
    if (!res.ok) fail("creating the agent failed");
    agentId = (res.data as { agent_id: string }).agent_id;
    console.log(`✔ agent created (${agentId})`);
    console.log(`\n  ➜ add to .env:  ELEVENLABS_AGENT_ID=${agentId}\n`);
  }

  // ------------------------------------------------- 4. phone (opt-in)
  if (withPhone) {
    if (!env.TWILIO_PHONE_NUMBER) fail("TWILIO_PHONE_NUMBER is not set");
    console.log(
      `\n⚠ CUTOVER: importing ${env.TWILIO_PHONE_NUMBER} — its INBOUND VOICE now routes to the ElevenLabs agent (SMS webhooks untouched).`,
    );
    const useApiKey = Boolean(env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET);
    const res = await api("POST", "/v1/convai/phone-numbers", {
      phone_number: env.TWILIO_PHONE_NUMBER,
      label: "Meatbox WA line",
      provider: "twilio",
      sid: useApiKey ? env.TWILIO_API_KEY_SID : env.TWILIO_ACCOUNT_SID,
      token: useApiKey ? env.TWILIO_API_KEY_SECRET : env.TWILIO_AUTH_TOKEN,
      ...(useApiKey ? { account_auth_token: env.TWILIO_AUTH_TOKEN } : {}),
      agent_id: agentId,
      enable_sms: false,
    });
    if (!res.ok) fail("phone number import failed");
    console.log(`✔ phone number imported and assigned to the agent`);
  } else {
    console.log(
      `\n(phone NOT touched — verify the agent first, then run again with --with-phone to cut the line over)`,
    );
  }

  console.log(`\nDone. Verify next:
  1. Dashboard test call (Agents → ${AGENT_NAME} → Test).
  2. Workspace Settings → Webhooks: add post-call webhook
     ${env.VOICE_PUBLIC_URL.replace(/\/$/, "")}/elevenlabs/post-call
     and put its signing secret in .env as ELEVENLABS_WEBHOOK_SECRET.
     (Skippable: the voice service also pulls transcripts itself.)
  3. Then: cutover with --with-phone.`);

  await closeDb();
}

main().catch((err) => fail(String(err)));
