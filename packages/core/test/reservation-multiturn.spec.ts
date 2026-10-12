import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ConversationalReservationBrain } from "../src/agent/reservation-brain";
import type { ReservationContext } from "../src/agent/reservation-machine";
import type { Interpretation, InterpreterInput, ReservationInterpreter, BookingField } from "../src/agent/reservation-interpreter";
import { getReservationSettings } from "../src/domain/reservations";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * DAY 7 — COMPLETE MULTI-TURN CONVERSATIONS (Kevin 2026-10-10). These are not isolated
 * phrases: each test is a whole call that combines many features — calendar grounding,
 * combined info, corrections, occasions, time changes, name spelling, questions, repeat
 * — to prove the features INTERACT correctly across a real conversation (real DB engine,
 * scripted interpreter so the orchestration is deterministic).
 */

let tctx: TestContext;
let db: pg.Pool;
const TZ = "Australia/Perth";
const MORNING = new Date("2026-10-05T02:00:00Z"); // Mon 5 Oct 2026, 10:00 Perth

beforeAll(async () => { tctx = await setupTestDb(); db = tctx.db; });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

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
const corr = (field: BookingField, phrase: string, confidence = 0.9) => ({ field, phrase, confidence });

/** Interpreter that returns a scripted interpretation per exact utterance. */
class FakeInterpreter implements ReservationInterpreter {
  constructor(private readonly map: Record<string, Interpretation>) {}
  async interpret(input: InterpreterInput): Promise<Interpretation> {
    return this.map[input.utterance] ?? I();
  }
}

async function brain(map: Record<string, Interpretation>, phone = "+61400556000"): Promise<ConversationalReservationBrain> {
  const rc: ReservationContext = {
    db, restaurantId: tctx.restaurant.id, restaurantName: "Meat Box", hours: tctx.hours,
    settings: await getReservationSettings(db, tctx.restaurant.id), timezone: TZ,
    now: () => MORNING, callerPhone: phone,
    address: tctx.restaurant.address, phoneDisplay: tctx.restaurant.phoneDisplay,
  };
  return new ConversationalReservationBrain(rc, { interpreter: new FakeInterpreter(map) });
}

describe("multi-turn — the worked example (grounding + combined + name + party change + occasion + time change + repeat)", () => {
  it("handles the whole winding conversation and books the FINAL state (5, Sat 31 Oct, 7:45, Walza, birthday)", async () => {
    const m = await brain({
      "I'd like Saturday three weeks from now, around half eight, for four": I({
        primary_intent: "NEW_RESERVATION",
        entities: { ...ent("date", "Saturday three weeks from now"), ...ent("time", "half eight"), ...ent("party_size", "four") },
      }),
      "yeah, my name's Walza": I({ confirmation: true, entities: ent("name", "Walza") }),
      "actually make that five": I({ corrections: [corr("party_size", "five")] }),
      "and it's my wife's birthday": I({ occasion: "my wife's birthday" }),
      "can we make it quarter to eight": I({ corrections: [corr("time", "quarter to eight")] }),
      "can you repeat what you've got": I({ request_to_repeat: true }),
      "yes": I({ confirmation: true }),
    });
    m.opening();
    const ground = await m.next("I'd like Saturday three weeks from now, around half eight, for four");
    expect(ground.say).toMatch(/just to check|that's/i);
    expect(ground.say).toMatch(/31st|saturday/i);              // calendar-grounded
    const afterName = await m.next("yeah, my name's Walza");   // confirms date + gives name
    expect(afterName.say).toMatch(/walza/i);
    const five = await m.next("actually make that five");      // party change
    expect(five.say).toMatch(/\b5\b|five/);
    expect(five.say).toMatch(/lock (it|that) in/i);
    const bday = await m.next("and it's my wife's birthday");  // occasion, flow continues
    expect(bday.say).toMatch(/birthday|surprise|nicer/i);
    const timeChg = await m.next("can we make it quarter to eight"); // time change
    expect(timeChg.say).toMatch(/7:45/);
    const repeat = await m.next("can you repeat what you've got"); // read-back of the LATEST state
    expect(repeat.say).toMatch(/\b5\b|five/);
    expect(repeat.say).toMatch(/7:45/);
    expect(repeat.say).toMatch(/walza/i);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(5);
    expect(m.reservation?.reservationDate).toBe("2026-10-31");
    expect(m.reservation?.reservationTime.slice(0, 5)).toBe("19:45");
    expect(m.reservation?.customerName).toBe("Walza");
    expect(m.reservation?.specialRequests).toMatch(/birthday|surprise/i);
  });
});

describe("multi-turn — a curveball call (question first, out-of-order, correction, occasion, name spelled)", () => {
  it("answers a question, takes facts out of order, corrects the party, spells the name, and books", async () => {
    const m = await brain({
      "do you have outdoor seating": I({ primary_intent: "ASK_QUESTION", customer_question: "do you have outdoor seating?" }),
      "a table for six next Saturday": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("date", "next Saturday"), ...ent("party_size", "six") } }),
      "half past eight": I({ entities: ent("time", "half past eight") }),
      "no wait, make it seven people": I({ corrections: [corr("party_size", "seven")] }),
      "99 00": I({ entities: ent("name", "99 00") }),       // unparseable name → recovery
      "Z A R A": I(),                                        // spelling (parsed from raw text)
      "yes": I({ confirmation: true }),
    }, "+61400556001");
    m.opening();
    const q = await m.next("do you have outdoor seating");
    expect(q.say).toMatch(/outdoor|window|booth|spot/i);   // question answered
    expect(q.say).toMatch(/day|when/i);                    // and steered to the booking
    await m.next("a table for six next Saturday");          // date + party (combined)
    await m.next("half past eight");                        // time
    const seven = await m.next("no wait, make it seven people"); // correction at the name step
    expect(seven.say).toMatch(/\b7\b|seven/);
    expect(seven.say).toMatch(/name/i);                    // party fixed, still needs the name
    await m.next("99 00");                                  // garbled name → "say it again"
    const spellAsk = await m.next("99 00");                 // → "spell it"
    expect(spellAsk.say).toMatch(/spell/i);
    const spelled = await m.next("Z A R A");               // → Zara, confirm
    expect(spelled.say).toMatch(/zara/i);
    await m.next("yes");                                    // confirm the name
    const done = await m.next("yes");                      // confirm the booking
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(7);
    expect(m.reservation?.customerName).toBe("Zara");
  });
});
