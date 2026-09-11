import { env, type RestaurantSettings } from "@meatbox/core";
import { relayToken } from "./twilio-signature";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * TwiML that hands the call to ConversationRelay over our WebSocket.
 * Voice/STT settings come from the database (Admin > Voice), falling back
 * to env defaults — nothing provider-specific is hard-coded.
 */
export function conversationRelayTwiml(params: {
  settings: RestaurantSettings;
  callSid: string;
  speechHintsExtra?: string[];
}): string {
  const { settings } = params;
  const ttsProvider = settings.ttsProvider || env.TWILIO_TTS_PROVIDER;
  const ttsVoice = settings.ttsVoice || env.TWILIO_TTS_VOICE;
  const sttProvider = settings.sttProvider || env.TWILIO_STT_PROVIDER;
  const language = settings.ttsLanguage || "en-AU";

  const token = relayToken(env.INTERNAL_API_SECRET || "dev-secret", params.callSid);
  const wsUrl = `${env.VOICE_WEBSOCKET_URL}?token=${token}`;

  const hints = [
    ...settings.speechHints.split(",").map((h) => h.trim()),
    ...(params.speechHintsExtra ?? []),
  ]
    .filter(Boolean)
    .slice(0, 50)
    .join(", ");

  const attrs: Record<string, string> = {
    url: wsUrl,
    welcomeGreeting: settings.aiGreeting,
    // "none": pickup noise must never cancel the greeting — callers were
    // getting silence and saying "Hello?" (2026-09-10).
    welcomeGreetingInterruptible: "none",
    language,
    ttsLanguage: language,
    transcriptionLanguage: language,
    ttsProvider,
    voice: ttsVoice,
    transcriptionProvider: sttProvider,
    interruptible: "speech",
    dtmfDetection: "false",
  };
  if (settings.sttModel) attrs.speechModel = settings.sttModel;
  // Google's en-AU telephony speech model rejects the hints attribute with
  // error 64101, which makes EVERY call fail busy (2026-09-10 incident).
  // Only send hints to providers that accept them.
  if (hints && sttProvider.toLowerCase() !== "google") attrs.hints = hints;

  const attrString = Object.entries(attrs)
    .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
    .join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><ConversationRelay ${attrString} /></Connect></Response>`;
}

/**
 * Hand the call to the ElevenLabs agent over SIP. The number stays fully
 * on Twilio; if the SIP leg fails, the action URL falls back to the
 * ConversationRelay stack so the restaurant line never goes dark.
 */
export function elevenLabsSipTwiml(params: { number: string; actionPath: string }): string {
  const sipUri = `sip:${params.number}@sip.rtc.elevenlabs.io:5061;transport=tls`;
  const auth =
    env.ELEVENLABS_SIP_USERNAME && env.ELEVENLABS_SIP_PASSWORD
      ? ` username="${xmlEscape(env.ELEVENLABS_SIP_USERNAME)}" password="${xmlEscape(env.ELEVENLABS_SIP_PASSWORD)}"`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Dial answerOnBridge="true" action="${xmlEscape(params.actionPath)}"><Sip${auth}>${xmlEscape(sipUri)}</Sip></Dial></Response>`;
}

/** Fallback TwiML when the AI can't take the call (e.g. missing API key). */
export function unavailableTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="en-AU">${xmlEscape(message)}</Say><Hangup/></Response>`;
}
