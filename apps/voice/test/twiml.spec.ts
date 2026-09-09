import { describe, expect, it } from "vitest";
import { conversationRelayTwiml, unavailableTwiml } from "../src/twiml";
import type { RestaurantSettings } from "@meatbox/core";

const settings: RestaurantSettings = {
  restaurantId: "r",
  ownerSmsNumber: "",
  customerSmsEnabled: false,
  futureOrdersEnabled: true,
  minPrepMinutes: 20,
  maxFutureHours: 8,
  orderNumberPrefix: "MB",
  aiGreeting: 'Hi, thanks for calling Meatbox. How can I help you today?',
  aiModel: "",
  fallbackBehaviour: "take_message",
  ttsProvider: "Google",
  ttsVoice: "en-AU-Neural2-A",
  ttsLanguage: "en-AU",
  sttProvider: "Deepgram",
  sttModel: "nova-3-general",
  speechHints: "Meatbox, Gozleme",
  recordingEnabled: false,
};

describe("ConversationRelay TwiML", () => {
  it("emits en-AU language, configured providers and a call-bound token", () => {
    const xml = conversationRelayTwiml({ settings, callSid: "CA123" });
    expect(xml).toContain("<Connect><ConversationRelay ");
    expect(xml).toContain('language="en-AU"');
    expect(xml).toContain('ttsProvider="Google"');
    expect(xml).toContain('voice="en-AU-Neural2-A"');
    expect(xml).toContain('transcriptionProvider="Deepgram"');
    expect(xml).toContain('speechModel="nova-3-general"');
    expect(xml).toContain("token=");
    expect(xml).toContain('welcomeGreeting="Hi, thanks for calling Meatbox');
    expect(xml).toContain("Meatbox, Gozleme");
  });

  it("adds dynamic menu hints", () => {
    const xml = conversationRelayTwiml({
      settings,
      callSid: "CA123",
      speechHintsExtra: ["Shish Taouk", "Lahme Skewer"],
    });
    expect(xml).toContain("Shish Taouk");
  });

  it("escapes XML in user-editable fields", () => {
    const xml = conversationRelayTwiml({
      settings: { ...settings, aiGreeting: 'G\'day "mate" <&>' },
      callSid: "CA123",
    });
    expect(xml).toContain("&quot;mate&quot;");
    expect(xml).toContain("&lt;&amp;&gt;");
    expect(xml).not.toContain('"mate" <&>');
  });

  it("renders a spoken fallback when the AI is unavailable", () => {
    const xml = unavailableTwiml("Sorry, please call back.");
    expect(xml).toContain('<Say language="en-AU">Sorry, please call back.</Say>');
    expect(xml).toContain("<Hangup/>");
  });
});
