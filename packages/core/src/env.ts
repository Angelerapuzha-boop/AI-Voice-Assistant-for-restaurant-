import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// Load the repo-root .env regardless of which app imports this module.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .default("postgres://meatbox:meatbox_dev_password@127.0.0.1:5441/meatbox"),
  TEST_DATABASE_URL: z
    .string()
    .default("postgres://meatbox:meatbox_dev_password@127.0.0.1:5441/meatbox_test"),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_PHONE_NUMBER: z.string().default(""),
  // Browser test-calls (Twilio Voice JS SDK): API key pair + TwiML app that
  // routes browser calls into the same /twilio/voice webhook.
  TWILIO_API_KEY_SID: z.string().default(""),
  TWILIO_API_KEY_SECRET: z.string().default(""),
  TWILIO_TWIML_APP_SID: z.string().default(""),

  TWILIO_TTS_PROVIDER: z.string().default("Google"),
  TWILIO_TTS_VOICE: z.string().default("en-AU-Neural2-A"),
  TWILIO_STT_PROVIDER: z.string().default("Deepgram"),

  OWNER_NOTIFICATION_PHONE: z.string().default(""),
  SMS_MODE: z.enum(["live", "log"]).default("log"),

  // n8n event webhook (optional): order.confirmed / order.needs_review /
  // owner_sms_failed events are POSTed here, HMAC-signed with the secret.
  N8N_WEBHOOK_URL: z.string().default(""),
  N8N_WEBHOOK_SECRET: z.string().default(""),

  // Square integration (optional): create an app at developer.squareup.com,
  // then the one-click Connect button in Admin > Integrations works.
  SQUARE_APP_ID: z.string().default(""),
  SQUARE_APP_SECRET: z.string().default(""),
  SQUARE_ENV: z.enum(["sandbox", "production"]).default("production"),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().default(""),
  SQUARE_TERMINAL_DEVICE_ID: z.string().default(""),

  // Phase 3 payments. mock_terminal is an EXPLICIT test adapter (clearly
  // badged in the UI); square_terminal requires a Square connection plus a
  // paired Terminal device. Never silently substituted for one another.
  PAYMENTS_PROVIDER: z.enum(["mock_terminal", "square_terminal"]).default("mock_terminal"),
  MOCK_TERMINAL_BEHAVIOUR: z.enum(["approve", "decline"]).default("approve"),
  MOCK_TERMINAL_DELAY_SECONDS: z.coerce.number().default(4),

  APP_URL: z.string().default("http://127.0.0.1:4810"),
  VOICE_WEBSOCKET_URL: z.string().default("ws://127.0.0.1:4811/twilio/relay"),
  VOICE_PUBLIC_URL: z.string().default("http://127.0.0.1:4811"),
  WEB_PORT: z.coerce.number().default(4810),
  VOICE_PORT: z.coerce.number().default(4811),
  HOST: z.string().default("127.0.0.1"),

  SESSION_SECRET: z.string().default(""),
  INTERNAL_API_SECRET: z.string().default(""),
  SENTRY_DSN: z.string().default(""),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

export function requireEnv(key: keyof Env): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
