import { describe, expect, it } from "vitest";
import { ReservationStateManager } from "../src/agent/reservation-state";
import type { BookingField, Correction, Interpretation } from "../src/agent/reservation-interpreter";
import type { Reservation } from "../src/types";
import type { AvailabilityResult } from "../src/domain/reservations";

/**
 * THE STATE MANAGER — pure, deterministic, no LLM, no DB. These tests pin the
 * hard-failure guarantees Kevin named (2026-10-08): the latest correction always
 * wins, any slot change invalidates stale availability, and a booking is never
 * asserted unless the DB row matches. If any of these regress, the conversational
 * brain can produce one of the forbidden outcomes.
 */

const TZ = "Australia/Perth";
const NOW = new Date("2026-10-05T02:00:00Z"); // Mon 5 Oct 2026, 10:00 Perth
const mgr = () => new ReservationStateManager({ now: () => NOW, timezone: TZ, maxAdvanceDays: 120 });

/** Terse Interpretation builder — fills neutral defaults, merges the override. */
function I(over: Partial<Interpretation> = {}): Interpretation {
  return {
    primary_intent: "PROVIDE_BOOKING_INFORMATION", secondary_intents: [], entities: {},
    corrections: [], customer_question: null, occasion: null, seating_request: null,
    special_request: null, confirmation: false, negation: false,
    request_to_repeat: false, request_to_wait: false, request_to_end_call: false,
    request_to_cancel: false, customer_confused: false, assistant_was_corrected: false,
    frustrated: false, uncertain_fields: [], confidence: 1, requires_clarification: false,
    recommended_action: "", reasoning: "test", ...over,
  };
}
const ent = (field: BookingField, phrase: string, confidence = 0.9) => ({ [field]: { phrase, confidence } });
const corr = (field: BookingField, phrase: string, confidence = 0.9): Correction => ({ field, phrase, confidence });

const AVAIL: AvailabilityResult = { status: "AVAILABLE", alternatives: [] };

describe("state manager — phrase resolution via the real parsers", () => {
  it("resolves date/time/party/name/phone phrases to concrete values", () => {
    const m = mgr();
    const r = m.apply(I({ entities: { ...ent("date", "next month the 14th"), ...ent("time", "half past seven"), ...ent("party_size", "just the two of us"), ...ent("name", "Joseph"), ...ent("phone", "0412 345 678") } }), "u", 1);
    expect(r.problems).toEqual([]);
    const v = m.values();
    expect(v.date).toBe("2026-11-14");
    expect(v.time).toBe("19:30");
    expect(v.partySize).toBe(2);
    expect(v.name).toBe("Joseph");
    expect(v.phone).toBe("+61412345678");
  });

  it("surfaces an ambiguous/invalid value as a problem, not a wrong guess", () => {
    const m = mgr();
    const r = m.apply(I({ entities: ent("date", "the 31st of February") }), "u", 1);
    expect(m.values().date).toBeUndefined();
    expect(r.problems[0]?.field).toBe("date");
  });
});

describe("state manager — provenance & latest-correction-wins", () => {
  it("first capture is revision 1; a correction bumps the revision and supersedes", () => {
    const m = mgr();
    m.apply(I({ entities: ent("date", "October 12th") }), "oct 12", 1);
    expect(m.fields.date?.value).toBe("2026-10-12");
    expect(m.fields.date?.revision).toBe(1);

    m.apply(I({ corrections: [corr("date", "November 14th")] }), "make it nov 14", 2);
    expect(m.fields.date?.value).toBe("2026-11-14"); // latest wins
    expect(m.fields.date?.revision).toBe(2);
    expect(m.fields.date?.confirmed).toBe(false); // a correction un-confirms
  });

  it("restating the SAME value is unchanged — no revision churn, stays confirmed", () => {
    const m = mgr();
    m.apply(I({ entities: ent("party_size", "four") }), "four", 1);
    m.confirmField("partySize");
    const r = m.apply(I({ entities: ent("party_size", "four") }), "yeah four", 2);
    expect(r.resolutions[0]?.kind).toBe("unchanged");
    expect(m.fields.partySize?.revision).toBe(1);
    expect(m.fields.partySize?.confirmed).toBe(true);
  });

  it("the correction wins even when the same field is ALSO mentioned as an entity in one turn", () => {
    const m = mgr();
    m.apply(I({ entities: ent("time", "seven") }), "seven", 1);
    // Caller: "seven — no wait, make it eight"
    const r = m.apply(I({ entities: ent("time", "seven"), corrections: [corr("time", "eight")] }), "seven no eight", 2);
    expect(m.fields.time?.value).toBe("20:00");
    expect(r.resolutions.filter((x) => x.field === "time").length).toBe(1); // correction only
  });
});

describe("state manager — stale availability invalidation", () => {
  it("a cached availability is fresh only while date/time/party are unchanged", () => {
    const m = mgr();
    m.apply(I({ entities: { ...ent("date", "October 12th"), ...ent("time", "seven"), ...ent("party_size", "four") } }), "u", 1);
    m.setAvailability(AVAIL);
    expect(m.freshAvailability()).toEqual(AVAIL);

    // Any slot change throws the stale result away.
    m.apply(I({ corrections: [corr("date", "November 14th")] }), "nov 14", 2);
    expect(m.freshAvailability()).toBeNull();
  });

  it("a slot change un-confirms the slot fields (the caller approved the OLD slot)", () => {
    const m = mgr();
    m.apply(I({ entities: { ...ent("date", "October 12th"), ...ent("time", "seven"), ...ent("party_size", "four") } }), "u", 1);
    m.confirmAll();
    expect(m.fields.time?.confirmed).toBe(true);
    m.apply(I({ corrections: [corr("time", "eight")] }), "make it eight", 2);
    expect(m.fields.time?.confirmed).toBe(false);
    expect(m.fields.date?.confirmed).toBe(false);
  });

  it("changing only the NAME does not invalidate availability", () => {
    const m = mgr();
    m.apply(I({ entities: { ...ent("date", "October 12th"), ...ent("time", "seven"), ...ent("party_size", "four") } }), "u", 1);
    m.setAvailability(AVAIL);
    m.apply(I({ entities: ent("name", "Joseph") }), "joseph", 2);
    expect(m.freshAvailability()).toEqual(AVAIL);
  });
});

describe("state manager — consistency check (no false confirmation)", () => {
  const res = (over: Partial<Reservation>): Reservation => ({
    id: "r1", restaurantId: "x", publicRef: "R1234", customerName: "Joseph", customerPhone: "+61412345678",
    reservationDate: "2026-11-14", reservationTime: "19:30:00", partySize: 2, status: "CONFIRMED",
    specialRequests: "", highChair: false, accessibility: false, occasion: "", seatingPref: "",
    nameStatus: "provided", needsStaffAttention: false,
    source: "phone", callId: null, idempotencyKey: null, createdAt: new Date(), updatedAt: new Date(), ...over,
  });

  it("passes when the DB row matches the confirmed state", () => {
    const m = mgr();
    m.apply(I({ entities: { ...ent("date", "November 14th"), ...ent("time", "half past seven"), ...ent("party_size", "two"), ...ent("name", "Joseph") } }), "u", 1);
    expect(m.consistencyCheck(res({}))).toEqual([]);
  });

  it("flags every field where the DB row differs from what the caller confirmed", () => {
    const m = mgr();
    m.apply(I({ entities: { ...ent("date", "November 14th"), ...ent("time", "half past seven"), ...ent("party_size", "two"), ...ent("name", "Joseph") } }), "u", 1);
    // The saved row says October 12 for 4 — must NOT be reported as booked-as-asked.
    const bad = m.consistencyCheck(res({ reservationDate: "2026-10-12", partySize: 4 }));
    const fields = bad.map((x) => x.field).sort();
    expect(fields).toEqual(["date", "partySize"]);
  });
});
