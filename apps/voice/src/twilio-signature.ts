import crypto from "node:crypto";

/**
 * Twilio webhook signature validation (X-Twilio-Signature):
 * Base64(HMAC-SHA1(authToken, url + sortedFormParamsConcatenated)).
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Call-scoped token embedded in the ConversationRelay WSS URL. */
export function relayToken(secret: string, callSid: string): string {
  return crypto.createHmac("sha256", secret).update(callSid).digest("base64url");
}

export function verifyRelayToken(secret: string, callSid: string, token: string): boolean {
  const expected = relayToken(secret, callSid);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
