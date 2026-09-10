import crypto from "node:crypto";
import { env } from "@meatbox/core";
import { guarded, requireUser } from "@/lib/session";

/**
 * Mints a short-lived Twilio Voice access token so an admin can place a
 * REAL voice call to the AI from the browser (no SIM, no phone network).
 * The TwiML app routes the call into the same /twilio/voice webhook as
 * the phone line. Admin-authenticated; token lives 1 hour.
 */

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export const POST = guarded(async () => {
  const user = await requireUser();
  if (!env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET || !env.TWILIO_TWIML_APP_SID) {
    return Response.json(
      { error: "Browser calling isn't configured (TWILIO_API_KEY_* / TWILIO_TWIML_APP_SID)." },
      { status: 503 },
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const identity = `browser-${user.email.split("@")[0]}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${env.TWILIO_API_KEY_SID}-${now}`,
    iss: env.TWILIO_API_KEY_SID,
    sub: env.TWILIO_ACCOUNT_SID,
    iat: now,
    exp: now + 3600,
    grants: {
      identity,
      voice: { outgoing: { application_sid: env.TWILIO_TWIML_APP_SID } },
    },
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = b64url(
    crypto.createHmac("sha256", env.TWILIO_API_KEY_SECRET).update(unsigned).digest(),
  );
  return Response.json({ token: `${unsigned}.${signature}`, identity, expiresIn: 3600 });
});
