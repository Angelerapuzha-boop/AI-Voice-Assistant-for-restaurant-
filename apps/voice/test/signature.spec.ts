import { describe, expect, it } from "vitest";
import {
  computeTwilioSignature,
  relayToken,
  validateTwilioSignature,
  verifyRelayToken,
} from "../src/twilio-signature";

describe("Twilio webhook signature", () => {
  const authToken = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };

  it("computes the documented Twilio example signature", () => {
    // Expected value from Twilio's security documentation example.
    expect(computeTwilioSignature(authToken, url, params)).toBe(
      "0/KCTR6DLpKmkAf8muzZqo1nDgQ=",
    );
  });

  it("validates matching signatures and rejects tampering", () => {
    const sig = computeTwilioSignature(authToken, url, params);
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(true);
    expect(validateTwilioSignature(authToken, sig, url, { ...params, Digits: "9999" })).toBe(false);
    expect(validateTwilioSignature(authToken, undefined, url, params)).toBe(false);
    expect(validateTwilioSignature(authToken, "bogus", url, params)).toBe(false);
  });
});

describe("relay token", () => {
  it("binds the WSS connection to the call", () => {
    const token = relayToken("secret", "CA123");
    expect(verifyRelayToken("secret", "CA123", token)).toBe(true);
    expect(verifyRelayToken("secret", "CA999", token)).toBe(false);
    expect(verifyRelayToken("other", "CA123", token)).toBe(false);
    expect(verifyRelayToken("secret", "CA123", "forged")).toBe(false);
  });
});
