import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ConversationalReservationBrain } from "../src/agent/reservation-brain";
import type { ReservationContext } from "../src/agent/reservation-machine";
import type { Interpretation, InterpreterInput, ReservationInterpreter, BookingField } from "../src/agent/reservation-interpreter";
import { unknownInterpretation } from "../src/agent/reservation-interpreter";
import { getReservationSettings, findReservations } from "../src/domain/reservations";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * THE CONVERSATIONAL BRAIN end-to-end (interpreter -> state manager -> real DB
 * engine -> planner), driven by a SCRIPTED fake interpreter so the controller is
 * tested deterministically without a live LLM. These lock down Kevin's forbidden
 * outcomes (2026-10-08): ignored corrections, stale values, false confirmations,
 * ignored questions — and recreate the "very bad" call that must now book
 * November 14, never October 12.
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

/** Scripted interpreter: returns a canned interpretation per exact utterance. */
class FakeInterpreter implements ReservationInterpreter {
  constructor(private readonly map: Record<string, Interpretation>) {}
  async interpret(input: InterpreterInput): Promise<Interpretation> {
    return this.map[input.utterance] ?? I();
  }
}

async function brain(map: Record<string, Interpretation>, callerPhone: string | null = "+61400555001"): Promise<ConversationalReservationBrain> {
  const rc: ReservationContext = {
    db, restaurantId: tctx.restaurant.id, restaurantName: "Meat Box", hours: tctx.hours,
    settings: await getReservationSettings(db, tctx.restaurant.id), timezone: TZ,
    now: () => MORNING, callerPhone: callerPhone ?? undefined,
    address: tctx.restaurant.address, phoneDisplay: tctx.restaurant.phoneDisplay,
  };
  return new ConversationalReservationBrain(rc, { interpreter: new FakeInterpreter(map) });
}

describe("conversational brain — happy path, out of order", () => {
  it("books when the party size is given before the date (no fixed checklist order)", async () => {
    const m = await brain({
      "table for four": I({ primary_intent: "NEW_RESERVATION", entities: ent("party_size", "four") }),
      "December 15th": I({ entities: ent("date", "December 15th") }),
      "seven": I({ entities: ent("time", "seven") }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "yes": I({ confirmation: true }),
    }, "+61400555010");
    expect(m.opening()).toMatch(/book a table/i);
    await m.next("table for four");
    await m.next("December 15th");
    await m.next("seven");
    const confirm = await m.next("Kevin");
    expect(confirm.say).toMatch(/lock (it|that) in/i);
    expect(confirm.say).toMatch(/December/);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.status).toBe("CONFIRMED");
    expect(m.reservation?.partySize).toBe(4);
    expect(m.reservation?.customerName).toBe("Kevin");
    expect(m.reservation?.reservationDate).toBe("2026-12-15");
  });
});

describe("conversational brain — the 'very bad' call, recreated", () => {
  it("a date change at the NAME step supersedes the old date; books November 14, never October 12", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "October the 12th": I({ entities: ent("date", "October the 12th") }),
      "seven": I({ entities: ent("time", "seven") }),
      "two": I({ entities: ent("party_size", "two") }),
      "Can you change the date to November 14th": I({
        primary_intent: "MODIFY_CURRENT_BOOKING",
        corrections: [corr("date", "November 14th")],
      }),
      "Joseph": I({ entities: ent("name", "Joseph") }),
      "yes": I({ confirmation: true }),
    }, "+61400555011");
    m.opening();
    await m.next("book a table");
    await m.next("October the 12th");
    await m.next("seven");
    await m.next("two");
    // The change that the old scripted bot ignored:
    const afterChange = await m.next("Can you change the date to November 14th");
    expect(afterChange.say).not.toMatch(/October|12th/i);
    const confirm = await m.next("Joseph");
    // The read-back MUST reflect the correction.
    expect(confirm.say).toMatch(/November/);
    expect(confirm.say).toMatch(/14th/);
    expect(confirm.say).not.toMatch(/October|12th/i);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.reservationDate).toBe("2026-11-14");
    expect(m.reservation?.customerName).toBe("Joseph");
  });
});

describe("conversational brain — a question is answered before the booking resumes", () => {
  it("answers 'do you have parking?' AND re-asks the pending question in one turn", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "tomorrow": I({ entities: ent("date", "tomorrow") }),
      "do you have parking": I({ primary_intent: "ASK_QUESTION", customer_question: "do you have parking?" }),
    }, "+61400555012");
    m.opening();
    await m.next("book a table"); // asks date
    const askTime = await m.next("tomorrow"); // asks time
    expect(askTime.say).toMatch(/time/i);
    const answered = await m.next("do you have parking");
    expect(answered.say).toMatch(/park/i); // the question is answered
    expect(answered.say).toMatch(/time/i); // and the booking resumes
  });
});

describe("conversational brain — a change at the confirm step re-checks availability (no stale confirm)", () => {
  it("changing the party size at the lock-in re-reads the new details, then books the NEW value", async () => {
    const m = await brain({
      "table for four": I({ primary_intent: "NEW_RESERVATION", entities: ent("party_size", "four") }),
      "December 15th": I({ entities: ent("date", "December 15th") }),
      "seven": I({ entities: ent("time", "seven") }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "actually make it six": I({ primary_intent: "MODIFY_CURRENT_BOOKING", corrections: [corr("party_size", "six")] }),
      "yes": I({ confirmation: true }),
    }, "+61400555013");
    m.opening();
    await m.next("table for four");
    await m.next("December 15th");
    await m.next("seven");
    const confirm4 = await m.next("Kevin");
    expect(confirm4.say).toMatch(/four|\b4\b/i);
    const confirm6 = await m.next("actually make it six");
    expect(confirm6.say).toMatch(/six|\b6\b/i); // re-read with the new value
    expect(confirm6.say).toMatch(/lock (it|that) in/i);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(6);
  });
});

describe("conversational brain — NO BLOCKAGES (Kevin: a caller must never get stuck)", () => {
  async function brainWith(interp: ReservationInterpreter, phone = "+61400555099"): Promise<ConversationalReservationBrain> {
    const rc: ReservationContext = {
      db, restaurantId: tctx.restaurant.id, restaurantName: "Meat Box", hours: tctx.hours,
      settings: await getReservationSettings(db, tctx.restaurant.id), timezone: TZ,
      now: () => MORNING, callerPhone: phone,
      address: tctx.restaurant.address, phoneDisplay: tctx.restaurant.phoneDisplay,
    };
    return new ConversationalReservationBrain(rc, { interpreter: interp });
  }

  it("the opening is INSTANT — a plain 'I'd like to book a table' skips the LLM", async () => {
    const dead: ReservationInterpreter = { async interpret() { return unknownInterpretation("timeout"); } };
    const m = await brainWith(dead);
    m.opening();
    const r = await m.next("I'd like to book a table"); // no details, no cancel/change
    expect(r.say).toMatch(/day|when/i);               // went straight to asking the day
    expect(r.say).not.toMatch(/didn'?t (quite )?catch/i); // did NOT fall back to the dead LLM
  });

  it("a detail at the greeting is NOT the bare greeting fast-path — and survives a dead LLM via deterministic parsing", async () => {
    const dead: ReservationInterpreter = { async interpret() { return unknownInterpretation("timeout"); } };
    const m = await brainWith(dead);
    m.opening();
    const r = await m.next("a table for four tomorrow"); // has details -> not the bare greeting path
    // Even with the LLM dead, the deterministic fallback reads "four" + "tomorrow" and
    // moves the booking on to the time — it does NOT degrade to "didn't catch that",
    // nor fall back to asking the day as the bare greeting path would.
    expect(r.say).toMatch(/time/i);
    expect(r.say).not.toMatch(/didn'?t (quite )?catch/i);
  });

  it("a persistently unavailable interpreter NEVER hangs up — it stays on the line, no loop (Kevin 2026-10-10)", async () => {
    const dead: ReservationInterpreter = { async interpret() { return unknownInterpretation("timeout"); } };
    const m = await brainWith(dead);
    m.opening();
    const says: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await m.next("mumble mumble");
      says.push(r.say.toLowerCase());
      expect(r.endCall).toBe(false); // ABSOLUTE: never hang up on a persistently garbled line
    }
    // Bounded, not a parrot: it never repeats the exact same line twice in a row.
    for (let i = 1; i < says.length; i++) expect(says[i]).not.toBe(says[i - 1]);
    expect(m.reservation).toBeNull();
  });

  it("a value the parser can never resolve NEVER hangs up — stays on the line, bounded", async () => {
    const junkDate: ReservationInterpreter = {
      async interpret() { return { ...I(), primary_intent: "PROVIDE_BOOKING_INFORMATION", entities: { date: { phrase: "qwerty zzz", confidence: 0.9 } } }; },
    };
    const m = await brainWith(junkDate);
    m.opening();
    for (let i = 0; i < 8; i++) {
      const r = await m.next("qwerty zzz");
      expect(r.endCall).toBe(false); // never hang up on an unresolvable value
    }
    expect(m.reservation).toBeNull();
  });

  it("endless unclear chatter AFTER a booking closes warmly and keeps the booking (never re-confirms or loops)", async () => {
    const m = await brain({
      "table for two tomorrow at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven") } }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "yes": I({ confirmation: true }),
    }, "+61400555098");
    m.opening();
    await m.next("table for two tomorrow at seven");
    await m.next("Kevin");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    const ref = m.reservation?.id;
    // Now ramble with unclear replies that are NOT in the map (neutral interp).
    let ended = false, turns = 0;
    for (let i = 0; i < 6 && !ended; i++) {
      const r = await m.next("hmm, uh, I dunno");
      turns++;
      expect(r.say).not.toMatch(/lock (it|that) in/i); // never tries to re-book
      if (r.endCall) ended = true;
    }
    expect(ended).toBe(true);
    expect(turns).toBeLessThanOrEqual(4);
    expect(m.reservation?.id).toBe(ref); // booking preserved
  });
});

describe("conversational brain — a group beyond even the party hall routes to the team, STAYS ON THE LINE", () => {
  it("a group too big even for the hall is routed to the team but the call is NOT hung up (Kevin 2026-10-10)", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "seven": I({ entities: ent("time", "seven") }),
      "80 people": I({ entities: ent("party_size", "80 people") }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "yes, eighty, I already said": I({ confirmation: true, entities: ent("party_size", "80") }),
    }, "+61400555097");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    await m.next("80 people");
    const first = await m.next("Kevin");
    expect(first.say).toMatch(/big one|beyond|personally|arrange/i); // gentle read-back
    expect(first.endCall).toBeFalsy();
    const second = await m.next("yes, eighty, I already said"); // caller insists on 80
    expect(second.say).toMatch(/team|arrange|confirm/i);          // routed to the team
    expect(second.endCall).toBeFalsy();                           // but NEVER hung up
    expect(second.say).toMatch(/anything else|any questions/i);   // keeps helping
    expect(m.reservation).toBeNull(); // never booked — beyond the hall's capacity
    expect((await findReservations(db, tctx.restaurant.id, "+61400555097")).length).toBe(0);
  });

  it("if the big number was a mishear, correcting it still books normally", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "seven": I({ entities: ent("time", "seven") }),
      "40 people": I({ entities: ent("party_size", "40 people") }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "no sorry, four": I({ primary_intent: "CORRECT_INFORMATION", corrections: [corr("party_size", "four")] }),
      "yes": I({ confirmation: true }),
    }, "+61400555096");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    await m.next("40 people");
    await m.next("Kevin"); // large-party read-back
    const fixed = await m.next("no sorry, four"); // corrected to 4
    expect(fixed.say).toMatch(/lock (it|that) in/i); // proceeds to confirm a normal booking
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(4);
  });
});

describe("conversational brain — RESILIENT to a dead/expired API key (deterministic fallback, Kevin 2026-10-09 'no more trouble')", () => {
  async function deadBrain(phone = "+61400555200"): Promise<ConversationalReservationBrain> {
    const dead: ReservationInterpreter = { async interpret() { return unknownInterpretation("401 invalid x-api-key"); } };
    const rc: ReservationContext = {
      db, restaurantId: tctx.restaurant.id, restaurantName: "Meat Box", hours: tctx.hours,
      settings: await getReservationSettings(db, tctx.restaurant.id), timezone: TZ,
      now: () => MORNING, callerPhone: phone,
      address: tctx.restaurant.address, phoneDisplay: tctx.restaurant.phoneDisplay,
    };
    return new ConversationalReservationBrain(rc, { interpreter: dead });
  }

  it("completes a full booking with the LLM interpreter DOWN — no key required", async () => {
    const m = await deadBrain();
    m.opening();
    await m.next("I'd like to book a table"); // greeting → asks day
    await m.next("this Saturday");
    await m.next("7pm");
    await m.next("four");                      // a bare "four" must be party 4, NOT 4 o'clock
    const confirm = await m.next("Kevin");
    expect(confirm.say).toMatch(/lock (it|that) in/i);
    expect(confirm.say).not.toMatch(/didn'?t (quite )?catch/i); // never the dead-LLM fallback
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(4);
    expect(m.reservation?.reservationTime?.slice(0, 5)).toBe("19:00");
    expect(m.reservation?.customerName).toBe("Kevin");
  });

  it("with the key down, a vague-day answer is handled gracefully — never the dead-LLM 'didn't catch'", async () => {
    const m = await deadBrain("+61400555201");
    m.opening();
    await m.next("book a table");                         // asks day
    const r = await m.next("after two weeks around 7pm"); // vague day
    expect(r.say).not.toMatch(/didn'?t (quite )?catch/i); // NOT the dead-LLM fallback
    expect(r.say).toMatch(/day/i);                        // steers on the (still-undecided) day
    expect(r.endCall).toBeFalsy();
    // And a concrete day next still carries the booking forward (keyless).
    await m.next("this Friday");
    await m.next("7pm");
    await m.next("four");
    const confirm = await m.next("Kevin");
    expect(confirm.say).toMatch(/lock (it|that) in/i);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
  });

  it("a big group still books into the party hall with the key down", async () => {
    const m = await deadBrain("+61400555202");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("7pm");
    await m.next("thirty people");   // "people" signal → party 30
    const c = await m.next("Kevin");
    expect(c.say).toMatch(/party hall/i);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(30);
    expect(m.reservation?.specialRequests).toMatch(/party hall/i);
  });
});

describe("conversational brain — UNIVERSAL loop guarantee: an answered side-question can't keep a stuck turn alive forever (Kevin 2026-10-09)", () => {
  it("a caller who dodges the confirm with an ANSWERABLE question every turn still reaches a terminal (never loops)", async () => {
    const m = await brain({
      "book a table for four this Saturday at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "this Saturday"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      // A REAL, answerable question (so answeredSomething is true) — the exact case
      // that used to reset the watchdog every turn and loop the confirm forever.
      "where are you located?": I({ primary_intent: "ASK_QUESTION", customer_question: "where are you located?" }),
    }, "+61400555072");
    m.opening();
    const confirm = await m.next("book a table for four this Saturday at seven, name Dev");
    expect(confirm.say).toMatch(/lock (it|that) in/i);
    let ended = false, turns = 0;
    for (let i = 0; i < 8 && !ended; i++) {
      const r = await m.next("where are you located?");
      turns++;
      if (m.reservation || r.endCall) ended = true;
    }
    expect(ended).toBe(true);               // bounded — it did NOT loop forever
    expect(turns).toBeLessThanOrEqual(7);   // terminated within a handful of dodges
  });

  it("never asks the exact same question twice in a row — a repeat is re-worded afresh", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "qwerty zzz": I({ entities: ent("date", "qwerty zzz") }), // never resolves → re-ask the day
    }, "+61400555073");
    m.opening();
    await m.next("book a table");                 // asks the day
    const r1 = await m.next("qwerty zzz");         // 1st "which day?" re-ask
    const r2 = await m.next("qwerty zzz");         // 2nd — MUST be worded differently
    expect(r1.say).toMatch(/day/i);
    expect(r2.say).toMatch(/day/i);
    expect(r2.say.toLowerCase()).not.toBe(r1.say.toLowerCase()); // not a verbatim repeat
  });
});

describe("conversational brain — CLOSED never loops, guides to the open window (Kevin 2026-10-09 '4:30' call)", () => {
  it("an out-of-hours time tells the hours, clears the time, and books the corrected time", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "four thirty": I({ entities: ent("time", "four thirty") }), // 16:30 → before 5pm → CLOSED
      "three people": I({ entities: ent("party_size", "three") }),
      "Raju": I({ entities: ent("name", "Raju") }),
      "seven": I({ entities: ent("time", "seven") }),             // 19:00 → open
      "yes": I({ confirmation: true }),
    }, "+61400555070");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("four thirty");
    await m.next("three people");
    const closed = await m.next("Raju"); // all fields set → CLOSED at 16:30
    expect(closed.say).toMatch(/open from/i);                   // states the hours, not a bare "closed then"
    expect(closed.say).toMatch(/what time/i);                   // asks specifically for a time
    expect(closed.say).not.toMatch(/what other day or time/i);  // the ambiguous looping phrase is gone
    expect(closed.endCall).toBeFalsy();
    const fixed = await m.next("seven"); // 7pm is open → proceeds to confirm (time was applied, re-checked)
    expect(fixed.say).toMatch(/lock (it|that) in/i);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.reservationTime?.slice(0, 5)).toBe("19:00");
  });

  it("a repeated closed re-ask never gets a cheerful ack and is never word-for-word identical", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "four thirty": I({ entities: ent("time", "four thirty") }), // 16:30 closed
      "three people": I({ entities: ent("party_size", "three") }),
      "Raju": I({ entities: ent("name", "Raju") }),
      "four": I({ entities: ent("time", "four") }),               // 16:00 still closed
    }, "+61400555074");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("four thirty");
    await m.next("three people");
    const c1 = await m.next("Raju"); // CLOSED #1
    const c2 = await m.next("four"); // CLOSED #2 (must be re-worded, no cheerful ack)
    for (const c of [c1, c2]) {
      expect(c.say).not.toMatch(/^\s*(perfect|great|lovely|wonderful|brilliant|certainly|of course)\b/i);
    }
    expect(c2.say.toLowerCase()).not.toBe(c1.say.toLowerCase()); // not verbatim
  });

  it("repeated out-of-hours times are bounded — a graceful call-back, never an endless 'closed then'", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "four thirty": I({ entities: ent("time", "four thirty") }),
      "three people": I({ entities: ent("party_size", "three") }),
      "Raju": I({ entities: ent("name", "Raju") }),
      "three thirty": I({ entities: ent("time", "three thirty") }), // 15:30 → closed
      "three": I({ entities: ent("time", "three") }),               // 15:00 → closed
      "four": I({ entities: ent("time", "four") }),                 // 16:00 → closed
    }, "+61400555071");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("four thirty");
    await m.next("three people");
    let held = false;
    for (const t of ["Raju", "three thirty", "three", "four", "two"]) {
      const r = await m.next(t);
      expect(r.say).not.toMatch(/we're actually closed then/i); // the old looping line is gone
      expect(r.endCall).toBe(false);                             // NEVER hangs up (Kevin 2026-10-10)
      if (/different day|another day|team|call you/i.test(r.say)) held = true;
    }
    expect(held).toBe(true);         // bounded — offered a different day / the team, staying on the line
    expect(m.reservation).toBeNull();
  });
});

describe("conversational brain — big groups book STRAIGHT into the party hall (Kevin 2026-10-09)", () => {
  it("a group over the table limit but within the hall books directly — no team call-back", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "seven": I({ entities: ent("time", "seven") }),
      "twenty five of us": I({ entities: ent("party_size", "twenty five") }),
      "Priya": I({ entities: ent("name", "Priya") }),
      "yes": I({ confirmation: true }),
    }, "+61400555060");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    await m.next("twenty five of us");
    const confirm = await m.next("Priya");
    expect(confirm.say).toMatch(/party hall/i);        // offered the hall, not a call-back
    expect(confirm.say).toMatch(/lock (it|that) in/i); // and it's a confirm, same turn
    expect(confirm.endCall).toBeFalsy();
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");               // BOOKED, not deferred to the team
    expect(m.reservation?.partySize).toBe(25);
    expect(m.reservation?.status).toBe("CONFIRMED");
    expect(m.reservation?.specialRequests).toMatch(/party hall/i); // tagged as a hall booking
  });

  it("a party-hall booking does NOT consume the main-floor per-slot cover limit", async () => {
    // A 30-person hall booking would blow the 20-cover slot limit if it counted;
    // because the hall is separate, a normal table at the same slot still fits.
    const hall = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "seven": I({ entities: ent("time", "seven") }),
      "thirty of us": I({ entities: ent("party_size", "thirty") }),
      "Omar": I({ entities: ent("name", "Omar") }),
      "yes": I({ confirmation: true }),
    }, "+61400555061");
    hall.opening();
    await hall.next("book a table");
    await hall.next("this Saturday");
    await hall.next("seven");
    await hall.next("thirty of us");
    await hall.next("Omar");
    expect((await hall.next("yes")).kind).toBe("confirmed");
    expect(hall.reservation?.partySize).toBe(30);

    const table = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "seven": I({ entities: ent("time", "seven") }),
      "four": I({ entities: ent("party_size", "four") }),
      "Dana": I({ entities: ent("name", "Dana") }),
      "yes": I({ confirmation: true }),
    }, "+61400555062");
    table.opening();
    await table.next("book a table");
    await table.next("this Saturday");
    await table.next("seven");
    await table.next("four");
    const confirm = await table.next("Dana");
    expect(confirm.say).toMatch(/lock (it|that) in/i); // still available — the hall's 30 didn't count
    expect((await table.next("yes")).kind).toBe("confirmed");
    expect(table.reservation?.partySize).toBe(4);
  });

  it("a big number corrected back down to a normal size drops the hall (books a table)", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "seven": I({ entities: ent("time", "seven") }),
      "thirty": I({ entities: ent("party_size", "thirty") }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "no sorry, four": I({ primary_intent: "CORRECT_INFORMATION", corrections: [corr("party_size", "four")] }),
      "yes": I({ confirmation: true }),
    }, "+61400555063");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    await m.next("thirty");
    const hallConfirm = await m.next("Kevin");
    expect(hallConfirm.say).toMatch(/party hall/i); // 30 → hall
    const fixed = await m.next("no sorry, four");   // corrected down to 4
    expect(fixed.say).toMatch(/lock (it|that) in/i);
    expect(fixed.say).not.toMatch(/party hall/i);   // hall dropped — it's a normal table now
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(4);
    expect(m.reservation?.specialRequests ?? "").not.toMatch(/party hall/i);
  });
});

describe("conversational brain — 'use the number I'm calling from' is understood (Kevin 2026-10-09)", () => {
  it("takes the caller ID as the phone instead of looping 'could you say that once more?'", async () => {
    const m = await brain({
      "book a table for four this Saturday at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "this Saturday"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      // The interpreter mis-extracts the phrase as a phone number; the brain should
      // recognise the caller-ID reference and NOT send it to the phone parser.
      "just take the same number I'm calling from": I({ primary_intent: "PROVIDE_BOOKING_INFORMATION", entities: ent("phone", "the same number I'm calling from") }),
      "yes": I({ confirmation: true }),
    }, "+61400555064");
    m.opening();
    await m.next("book a table for four this Saturday at seven, name Dev"); // → confirm read-back
    const r = await m.next("just take the same number I'm calling from");
    expect(r.say).not.toMatch(/say that (once more|again)/i); // no unparseable-phone loop
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.customerPhone).toBe("+61400555064"); // booked under the caller ID
  });
});

describe("conversational brain — undecided date/time gives a soft beat, never drops or dances (Kevin 2026-10-09)", () => {
  it("an undecided DAY offers a call-back AND keeps the line open ('or shall I book now?'), then ends on 'no'", async () => {
    const m = await brain({
      "I'd like to book a table": I({ primary_intent: "NEW_RESERVATION" }),
    }, "+61400555095");
    m.opening();
    await m.next("I'd like to book a table"); // asks the day
    const r = await m.next("sometime in the next couple of weeks, I haven't decided the day yet");
    expect(r.kind).toBe("undecided_offer");      // soft beat, NOT a hard close
    expect(r.endCall).toBeFalsy();               // call stays open — no drop
    expect(r.say).toMatch(/call back|anything else|book.*now/i);
    const r2 = await m.next("no, that's all for now, thanks"); // they're done
    expect(r2.endCall).toBe(true);
    expect(m.reservation).toBeNull();
  });

  it("if the caller suddenly decides a day on that beat, it carries on and books (no drop)", async () => {
    const m = await brain({
      "I'd like to book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "actually, let's do this Friday at seven, four of us, name Kevin": I({ primary_intent: "PROVIDE_BOOKING_INFORMATION", entities: { ...ent("date", "this Friday"), ...ent("time", "seven"), ...ent("party_size", "four"), ...ent("name", "Kevin") } }),
      "yes": I({ confirmation: true }),
    }, "+61400555094");
    m.opening();
    await m.next("I'd like to book a table");
    const beat = await m.next("I haven't decided the day yet, sometime in a couple of weeks");
    expect(beat.kind).toBe("undecided_offer");
    const r = await m.next("actually, let's do this Friday at seven, four of us, name Kevin");
    expect(r.say).toMatch(/lock (it|that) in|particular|party hall|special occasion/i); // proceeded to confirm
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed"); // booked — the line was NOT dropped
  });

  it("a real date wrapped in hesitation still books (not treated as undecided)", async () => {
    const m = await brain({
      "I'd like to book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "I'm not sure, maybe this Friday": I({ entities: ent("date", "this Friday") }),
    }, "+61400555093");
    m.opening();
    await m.next("I'd like to book a table");
    const r = await m.next("I'm not sure, maybe this Friday"); // vague words BUT a real day
    expect(r.kind).not.toBe("undecided_offer");
    expect(r.say).toMatch(/time/i); // moved on to ask the time
  });
});

describe("conversational brain — occasion & confirm/repeat extras (Kevin 2026-10-08)", () => {
  it("an anniversary gets a romantic-table suggestion, noted on the booking", async () => {
    const m = await brain({
      "table for two this Friday at seven, it's our anniversary": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "this Friday"), ...ent("time", "seven") } }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "yes": I({ confirmation: true }),
    }, "+61400555092");
    m.opening();
    const r1 = await m.next("table for two this Friday at seven, it's our anniversary");
    expect(r1.say).toMatch(/romantic|anniversary/i); // suggested a romantic spot
    await m.next("Kevin");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.specialRequests).toMatch(/romantic|anniversary/i); // noted on the booking
  });

  it("size-tiered area offer is folded into the confirm line (no extra turn)", async () => {
    const mkMap = (party: string) => ({
      [`table for ${party} this Saturday at seven, name Dev`]: I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", party), ...ent("date", "this Saturday"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
    });
    // 9 people → party hall offer in the confirm line
    const big = await brain(mkMap("nine"), "+61400555081");
    big.opening();
    const c9 = await big.next("table for nine this Saturday at seven, name Dev");
    expect(c9.say).toMatch(/party hall/i);
    expect(c9.say).toMatch(/lock (it|that) in/i); // still the confirm, same turn
    // 5 people → particular-area offer
    const mid = await brain(mkMap("five"), "+61400555082");
    mid.opening();
    const c5 = await mid.next("table for five this Saturday at seven, name Dev");
    expect(c5.say).toMatch(/window|booth|quieter|particular spot/i);
    expect(c5.say).toMatch(/lock (it|that) in/i);
    // 2 people, no occasion → special-occasion check
    const sml = await brain(mkMap("two"), "+61400555083");
    sml.opening();
    const c2 = await sml.next("table for two this Saturday at seven, name Dev");
    expect(c2.say).toMatch(/special occasion|birthday|anniversary/i);
    expect(c2.say).toMatch(/lock (it|that) in/i);
    // The confirm asks exactly ONE question — the area/occasion offer is a statement,
    // never a second "?" stacked before "lock that in?" (Kevin 2026-10-09: perfect call).
    for (const c of [c9, c5, c2]) expect((c.say.match(/\?/g) || []).length).toBe(1);
  });

  it("asking 'what areas are available?' lists real options, not a generic deflection", async () => {
    const m = await brain({
      "table for eight this Saturday at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "eight"), ...ent("date", "this Saturday"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      "what areas are available?": I({ primary_intent: "ASK_QUESTION", customer_question: "what areas are available?" }),
    }, "+61400555088");
    m.opening();
    await m.next("table for eight this Saturday at seven, name Dev"); // confirm read-back
    const ans = await m.next("what areas are available?");
    expect(ans.say).toMatch(/window|booth|quieter|outdoor|party hall/i); // real options listed
    expect(ans.say).not.toMatch(/make a note for the team/i);            // not the deflection
  });

  it("a complete booking whose NAME the line garbles recovers, defers the name, and BOOKS — never a team call-back/hang-up (Kevin 2026-10-09/10)", async () => {
    const m = await brain({
      "table for two tomorrow at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven") } }),
      "12345": I({ entities: ent("name", "12345") }), // never resolves as a name
      "yes": I({ confirmation: true }),
    }, "+61400555085");
    m.opening();
    await m.next("table for two tomorrow at seven"); // asks the name
    let reachedConfirm = false;
    for (let i = 0; i < 6 && !reachedConfirm; i++) {
      const r = await m.next("12345"); // garbled name — recovery: repeat → spell → defer
      expect(r.endCall).toBe(false);   // NEVER hangs up on a garbled name
      if (/lock (it|that) in/i.test(r.say)) reachedConfirm = true;
    }
    expect(reachedConfirm).toBe(true); // deferred the name, carried on to the booking read-back
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed"); // booked (no team call-back)
    expect(m.reservation?.partySize).toBe(2);
  });

  it("an apologetic re-ask never gets a cheerful ack prefix ('Brilliant — sorry…')", async () => {
    const m = await brain({
      "book a table for two tomorrow at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven") } }),
      "12345": I({ entities: ent("name", "12345") }), // unparseable as a name
    }, "+61400555086");
    m.opening();
    await m.next("book a table for two tomorrow at seven"); // asks the name
    const r = await m.next("12345"); // can't parse -> apologetic re-ask
    expect(r.say).toMatch(/^sorry/i); // starts with the apology, no cheerful prefix
    expect(r.say).not.toMatch(/^(lovely|wonderful|brilliant|great|perfect|of course|no worries|certainly)\b/i);
  });

  it("a party-hall request at the confirm step is acknowledged and noted, never ignored", async () => {
    const m = await brain({
      "table for ten this Saturday at seven thirty, name Suzanne": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "ten"), ...ent("date", "this Saturday"), ...ent("time", "seven thirty"), ...ent("name", "Suzanne") } }),
      "yes, and can you book a party hall?": I({ primary_intent: "AFFIRM", confirmation: true, customer_question: "can you book a party hall?" }),
    }, "+61400555089");
    m.opening();
    await m.next("table for ten this Saturday at seven thirty, name Suzanne"); // -> confirm read-back
    const done = await m.next("yes, and can you book a party hall?");
    expect(done.kind).toBe("confirmed");
    expect(done.say).toMatch(/party hall/i);                 // acknowledged, not ignored
    expect(m.reservation?.specialRequests).toMatch(/party hall/i); // noted on the booking
  });

  it("a birthday gets a nice surprise-spot suggestion, noted on the booking", async () => {
    const m = await brain({
      "table for six this Friday at seven, it's my daughter's birthday": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "six"), ...ent("date", "this Friday"), ...ent("time", "seven") } }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "yes": I({ confirmation: true }),
    }, "+61400555090");
    m.opening();
    const r1 = await m.next("table for six this Friday at seven, it's my daughter's birthday");
    expect(r1.say).toMatch(/surprise|nicer spot|birthday/i); // suggested a nice surprise spot
    await m.next("Kevin");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.specialRequests).toMatch(/birthday|surprise/i); // noted on the booking
  });

  it("at the confirm step, a repeat request re-reads the full reservation AND re-asks to confirm", async () => {
    const m = await brain({
      "table for four December 15th at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "December 15th"), ...ent("time", "seven") } }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "can you repeat the reservation please": I({ request_to_repeat: true }),
      "yes": I({ confirmation: true }),
    }, "+61400555091");
    m.opening();
    await m.next("table for four December 15th at seven");
    const atConfirm = await m.next("Kevin");
    expect(atConfirm.say).toMatch(/lock (it|that) in/i);
    const repeated = await m.next("can you repeat the reservation please");
    expect(repeated.say).toMatch(/\b4\b|four/i);        // reads the full reservation back
    expect(repeated.say).toMatch(/December/);
    expect(repeated.say).toMatch(/lock (it|that) in/i); // and re-asks to confirm
    expect(repeated.endCall).toBeFalsy();               // never drops
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
  });
});

describe("conversational brain — the 'team will confirm' fallback is bounded, never loops (Kevin 2026-10-09)", () => {
  it("repeated unanswerable questions steer to wrap-up and end the call, not an endless deflection", async () => {
    const q = (text: string): [string, Interpretation] => [text, I({ primary_intent: "ASK_QUESTION", customer_question: text })];
    const m = await brain(Object.fromEntries([
      ["book a table for four this Saturday at seven, name Dev", I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "this Saturday"), ...ent("time", "seven"), ...ent("name", "Dev") } })],
      q("what's the wifi password?"), q("do you have a mascot?"), q("what colour are the walls?"),
      q("and the ceiling?"), q("and the carpet?"), q("and the chairs?"),
    ]), "+61400555087");
    m.opening();
    await m.next("book a table for four this Saturday at seven, name Dev"); // confirm read-back
    const r1 = await m.next("what's the wifi password?");  // 1st deflection (team will confirm)
    expect(r1.say).toMatch(/team/i);
    const r2 = await m.next("do you have a mascot?");       // 2nd -> steers to locking in
    expect(r2.say).toMatch(/lock|sort|get your table/i);
    // Keep barraging unanswerable questions — it MUST reach a terminal outcome,
    // never loop the deflection. With a full booking in hand it JUST BOOKS (Kevin
    // 2026-10-09: "in ending no need for team to book, just book").
    let done = false, turns = 0;
    for (const query of ["what colour are the walls?", "and the ceiling?", "and the carpet?", "and the chairs?"]) {
      const r = await m.next(query);
      turns++;
      if (m.reservation || r.endCall) { done = true; break; }
    }
    expect(done).toBe(true);              // bounded — never an infinite deflection loop
    expect(m.reservation).not.toBeNull(); // and it booked rather than deferring to the team
    expect(turns).toBeLessThanOrEqual(4);
  });
});

describe("conversational brain — DAY 8 difficult-audio hardening (live India call CA4af9bb, Kevin 2026-10-10)", () => {
  it("an IMPOSSIBLE date change ('31st of November') is clarified, never a silent 'okay, anything else?'", async () => {
    const m = await brain({
      "table for two tomorrow at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      "yes": I({ confirmation: true }),
      "change it to the 31st of November": I({ primary_intent: "MODIFY_CURRENT_BOOKING", corrections: [corr("date", "31st of November")] }),
    }, "+61400555280");
    m.opening();
    await m.next("table for two tomorrow at seven, name Dev");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    const bookedDate = m.reservation?.reservationDate;
    const r = await m.next("change it to the 31st of November"); // November has 30 days
    expect(r.say).toMatch(/doesn'?t look|which day|didn'?t catch|sorry/i); // CLARIFIES
    expect(r.say).not.toMatch(/^okay\b.*anything else/i);                   // not a silent brush-off
    expect(r.endCall).toBe(false);
    expect(m.reservation?.reservationDate).toBe(bookedDate); // original booking untouched by the bad date
  });
});

describe("conversational brain — DAY 6 flexible Q&A, occasions, large-group handling (Kevin 2026-10-10)", () => {
  it("a dietary question is answered (offer to note for the kitchen), not a generic deflection", async () => {
    const m = await brain({
      "table for two this Saturday at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "this Saturday"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      "do you do gluten free?": I({ primary_intent: "ASK_QUESTION", customer_question: "do you do gluten free?" }),
    }, "+61400555260");
    m.opening();
    await m.next("table for two this Saturday at seven, name Dev"); // confirm read-back
    const ans = await m.next("do you do gluten free?");
    expect(ans.say).toMatch(/dietary|note|kitchen/i);
    expect(ans.say).not.toMatch(/make a note for the team when they're in touch/i); // not the generic fallback
    expect(ans.endCall).toBe(false);
  });

  it("an occasion given WITH a booking detail is noted but NEVER overrides the main flow", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday at seven": I({ entities: { ...ent("date", "this Saturday"), ...ent("time", "seven") } }),
      "four, and it's my wife's birthday": I({ entities: ent("party_size", "four"), occasion: "my wife's birthday" }),
      "Dev": I({ entities: ent("name", "Dev") }),
      "yes": I({ confirmation: true }),
    }, "+61400555261");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday at seven");
    const r = await m.next("four, and it's my wife's birthday");
    expect(r.say).toMatch(/birthday|surprise|nicer/i); // occasion noted
    expect(r.say).toMatch(/name/i);                    // but the flow carries on (asks name)
    await m.next("Dev");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(4);
    expect(m.reservation?.specialRequests).toMatch(/birthday|surprise/i);
  });

  it("COMBINED INFO: a two-fact answer ('this Saturday at seven') captures BOTH, not just the asked field", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday at seven": I({ entities: { ...ent("date", "this Saturday"), ...ent("time", "seven") } }),
    }, "+61400555263");
    m.opening();
    await m.next("book a table");                     // asks the day
    const r = await m.next("this Saturday at seven"); // both date AND time
    expect(r.say).toMatch(/how many|dining/i);        // moved on to party size
    expect(r.say).not.toMatch(/what time|time suits/i); // did NOT drop the time and re-ask it
  });

  it("after a too-big group is routed to the team, a follow-up question is ANSWERED and the call stays open", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Saturday": I({ entities: ent("date", "this Saturday") }),
      "seven": I({ entities: ent("time", "seven") }),
      "eighty": I({ entities: ent("party_size", "eighty") }),
      "Dev": I({ entities: ent("name", "Dev") }),
      "yes, eighty": I({ confirmation: true, entities: ent("party_size", "eighty") }),
      "where are you located?": I({ primary_intent: "ASK_QUESTION", customer_question: "where are you located?" }),
    }, "+61400555262");
    m.opening();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    await m.next("eighty");
    await m.next("Dev");          // → large-party read-back
    const routed = await m.next("yes, eighty"); // → routed to team, stays open
    expect(routed.endCall).toBe(false);
    const q = await m.next("where are you located?"); // a question AFTER routing
    expect(q.say).toMatch(/located|we're at|address|team/i); // answered
    expect(q.endCall).toBe(false);                          // still on the line
  });
});

describe("conversational brain — DAY 5 corrections & conversational control (Kevin 2026-10-10)", () => {
  it("a party-size change DURING the name step is applied and re-read; the name is still asked, not mis-read", async () => {
    const m = await brain({
      "table for four this Saturday at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "this Saturday"), ...ent("time", "seven") } }),
      "actually make it six": I({ primary_intent: "MODIFY_CURRENT_BOOKING", corrections: [corr("party_size", "six")] }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "yes": I({ confirmation: true }),
    }, "+61400555250");
    m.opening();
    await m.next("table for four this Saturday at seven"); // asks the name
    const changed = await m.next("actually make it six");  // a change, not a name
    expect(changed.say).toMatch(/\b6\b|six/i);             // party updated
    expect(changed.say).toMatch(/name/i);                  // still asks the name (not mis-read as one)
    await m.next("Kevin");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(6);
  });

  it("when the caller says WE got it wrong, the fix is OWNED specifically ('you're right … changed the date to …')", async () => {
    const m = await brain({
      "book a table for two this Friday at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "this Friday"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      "no, I said Saturday not Friday": I({ primary_intent: "CORRECT_INFORMATION", assistant_was_corrected: true, negation: true, corrections: [corr("date", "Saturday")] }),
      "yes": I({ confirmation: true }),
    }, "+61400555251");
    m.opening();
    const confirm = await m.next("book a table for two this Friday at seven, name Dev"); // read-back (Friday)
    expect(confirm.say).toMatch(/friday/i);
    const fixed = await m.next("no, I said Saturday not Friday");
    expect(fixed.say).toMatch(/you'?re right/i);   // owns it
    expect(fixed.say).toMatch(/saturday/i);        // the corrected value, named
    expect(fixed.say).not.toMatch(/friday/i);      // the wrong value is gone
    expect(fixed.endCall).toBe(false);
  });

  it("frustration gets ONE brief acknowledgement then action — not generic, not repeated apologies", async () => {
    const m = await brain({
      "book a table for two this Friday at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "this Friday"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      "you keep getting it wrong, I said Saturday": I({ primary_intent: "CORRECT_INFORMATION", assistant_was_corrected: true, frustrated: true, corrections: [corr("date", "Saturday")] }),
      "and six people not two": I({ primary_intent: "CORRECT_INFORMATION", frustrated: true, corrections: [corr("party_size", "six")] }),
      "yes": I({ confirmation: true }),
    }, "+61400555252");
    m.opening();
    await m.next("book a table for two this Friday at seven, name Dev");
    const r1 = await m.next("you keep getting it wrong, I said Saturday");
    expect(r1.say).toMatch(/sorry/i);              // one acknowledgement
    expect(r1.say).toMatch(/saturday/i);           // and the fix
    const r2 = await m.next("and six people not two");
    expect(r2.say.toLowerCase().match(/sorry/g)?.length ?? 0).toBeLessThanOrEqual(1); // not stacking apologies
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.partySize).toBe(6);
  });

  it("the booking confirmation is calm — no gushy 'Perfect/Lovely/Wonderful/Brilliant'", async () => {
    const m = await brain({
      "table for two tomorrow at seven, name Dev": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven"), ...ent("name", "Dev") } }),
      "yes": I({ confirmation: true }),
    }, "+61400555253");
    m.opening();
    await m.next("table for two tomorrow at seven, name Dev");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(done.say).not.toMatch(/\b(perfect|lovely|wonderful|brilliant|absolutely)\b/i);
    expect(done.say).toMatch(/booked in/i); // still warm + clear
  });
});

describe("conversational brain — DAY 4 name recovery: repeat → spell → confirm, NEVER abandon (reference 'R-A-J-U')", () => {
  it("an unclear name is retried, then spelled, then confirmed — and books, never hangs up", async () => {
    const m = await brain({
      "table for two tomorrow at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven") } }),
      "99 88 77": I({ entities: ent("name", "99 88 77") }), // unparseable — simulates a garbled name
      "yes": I({ confirmation: true }),
    }, "+61400555240");
    m.opening();
    await m.next("table for two tomorrow at seven"); // asks the name
    const r1 = await m.next("99 88 77");             // attempt 1 → say it again
    expect(r1.say).toMatch(/say it once more|didn'?t catch the name/i);
    expect(r1.endCall).toBe(false);
    const r2 = await m.next("99 88 77");             // attempt 2 → spell it
    expect(r2.say).toMatch(/spell/i);
    expect(r2.endCall).toBe(false);
    const r3 = await m.next("W - A - L - Z - A");    // spelling → Walza, read back
    expect(r3.say).toMatch(/walza/i);
    expect(r3.say).toMatch(/is that right|got it/i);
    const lockin = await m.next("yes");              // confirm name → booking read-back
    expect(lockin.say).toMatch(/lock (it|that) in/i);
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.customerName).toBe("Walza");
  });

  it("if even spelling fails, it DEFERS the name to the team and books the rest — never abandons, never invents a name", async () => {
    const m = await brain({
      "table for two tomorrow at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven") } }),
      "99 88 77": I({ entities: ent("name", "99 88 77") }),
      "yes": I({ confirmation: true }),
    }, "+61400555241");
    m.opening();
    await m.next("table for two tomorrow at seven");
    await m.next("99 88 77"); // attempt 1
    await m.next("99 88 77"); // attempt 2 → spell
    const s1 = await m.next("9 9 9"); // spelling miss 1
    expect(s1.endCall).toBe(false);
    const s2 = await m.next("9 9 9"); // spelling miss 2 → defer, keep details, carry on
    expect(s2.endCall).toBe(false);
    expect(s2.say).toMatch(/lock (it|that) in/i); // proceeded to the booking read-back
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");             // booked WITHOUT a name
    expect(m.reservation?.partySize).toBe(2);
    expect(m.reservation?.customerName ?? "").not.toMatch(/\d|99|88|77/); // no garbage name stored
  });
});

describe("conversational brain — DAY 3 calendar grounding: a far relative date is confirmed, never silently booked", () => {
  it("'the Saturday three weeks from now' is read back as the concrete date to confirm", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "the Saturday three weeks from now": I({ entities: ent("date", "the Saturday three weeks from now") }),
      "seven": I({ entities: ent("time", "seven") }),
      "four": I({ entities: ent("party_size", "four") }),
      "Kevin": I({ entities: ent("name", "Kevin") }),
      "yes": I({ confirmation: true }),
    }, "+61400555230");
    m.opening();
    await m.next("book a table"); // asks day
    const ground = await m.next("the Saturday three weeks from now");
    // NOW in the brain spec = Mon 5 Oct 2026, so the Saturday 3 weeks out = 31 Oct.
    expect(ground.say).toMatch(/just to check|that's/i);
    expect(ground.say).toMatch(/31st|october/i); // the CONCRETE calendar date, read back
    expect(ground.endCall).toBeFalsy();
    const afterYes = await m.next("yes"); // confirms the date → asks the time
    expect(afterYes.say).toMatch(/time/i);
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.reservationDate).toBe("2026-10-31");
  });

  it("a NEAR date ('this Friday') is NOT given an extra grounding step", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "this Friday": I({ entities: ent("date", "this Friday") }),
    }, "+61400555231");
    m.opening();
    await m.next("book a table");
    const r = await m.next("this Friday");
    expect(r.say).toMatch(/time/i);            // straight on to the time, no "just to check"
    expect(r.say).not.toMatch(/just to check/i);
  });
});

describe("conversational brain — DAY 2 semantic layer: richer signals captured in one pass (Kevin 2026-10-10)", () => {
  it("a dietary/special request is captured on the booking and acknowledged (reference: 'allergic to shrimp')", async () => {
    const m = await brain({
      "table for two tomorrow at seven, name Kevin": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven"), ...ent("name", "Kevin") } }),
      "oh, I'm allergic to shrimp and no avocado": I({ special_request: "allergic to shrimp, no avocado" }),
      "yes": I({ confirmation: true }),
    }, "+61400555220");
    m.opening();
    await m.next("table for two tomorrow at seven, name Kevin"); // → confirm read-back
    const noted = await m.next("oh, I'm allergic to shrimp and no avocado");
    expect(noted.say).toMatch(/note/i);        // acknowledged, not ignored
    expect(noted.endCall).toBeFalsy();
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.specialRequests).toMatch(/shrimp/i); // on the booking for the team
  });

  it("an UNCERTAIN name is read back for confirmation, never trusted silently (sets up spelling recovery)", async () => {
    const m = await brain({
      "table for two tomorrow at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "tomorrow"), ...ent("time", "seven") } }),
      "um, it's Walza, or maybe Waldza": I({ entities: ent("name", "Walza", 0.9), uncertain_fields: ["name"] }),
      "yes": I({ confirmation: true }),
    }, "+61400555221");
    m.opening();
    await m.next("table for two tomorrow at seven"); // asks name
    const readback = await m.next("um, it's Walza, or maybe Waldza");
    expect(readback.say).toMatch(/walza/i);             // best guess surfaced
    expect(readback.say).toMatch(/is that right|got the name/i); // CONFIRMED, not trusted
    expect(readback.endCall).toBeFalsy();
    const lockin = await m.next("yes");                 // confirms the name → booking read-back
    expect(lockin.say).toMatch(/lock (it|that) in/i);
    const done = await m.next("yes");                   // confirms the booking
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.customerName).toBe("Walza");
  });

  it("the interpreter's request_to_end_call ends warmly even with no deterministic keyword", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "actually I'll sort it later": I({ primary_intent: "OUT_OF_SCOPE", request_to_end_call: true }),
    }, "+61400555222");
    m.opening();
    await m.next("book a table");
    const bye = await m.next("actually I'll sort it later");
    expect(bye.endCall).toBe(true);
    expect(bye.kind).toBe("goodbye");
    expect(m.reservation).toBeNull();
  });
});

describe("conversational brain — a garbled answer NEVER hangs up (Kevin 2026-10-10: 'I told the name but it rudely cut the call')", () => {
  it("a name that the line's STT turns into a number-flood re-asks, then books — never 'abandoned'", async () => {
    const flood = "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14";
    const m = await brain({
      "book a table for four this Saturday at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "this Saturday"), ...ent("time", "seven") } }),
      // Even if the interpreter WOULD misread the gibberish as ABANDON, the degenerate
      // guard intercepts it first and it never reaches here.
      [flood]: I({ primary_intent: "ABANDON" }),
    }, "+61400555210");
    m.opening();
    await m.next("book a table for four this Saturday at seven"); // asks the name
    let booked = false;
    for (let i = 0; i < 7 && !booked; i++) {
      const r = await m.next(flood);
      expect(r.kind).not.toBe("abandoned");          // NEVER a rude hang-up
      expect(r.say).not.toMatch(/won'?t book anything/i);
      if (m.reservation) booked = true;
    }
    expect(booked).toBe(true);                        // had date+time+party → just books
    expect(m.reservation?.partySize).toBe(4);
    expect(m.reservation?.status).toBe("CONFIRMED");
  });

  it("an INFERRED abandon with no explicit cue does not end the call", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "mumble gibberish wotsit": I({ primary_intent: "ABANDON" }), // LLM inferred abandon, but no explicit cue
    }, "+61400555212");
    m.opening();
    await m.next("book a table");
    const r = await m.next("mumble gibberish wotsit");
    expect(r.kind).not.toBe("abandoned"); // not an explicit abandon → do NOT hang up
    expect(r.endCall).toBeFalsy();
  });
});

describe("conversational brain — NAME FALLBACK HIERARCHY (Kevin 2026-10-10 final acceptance)", () => {
  it("garbled name → re-ask → ask to spell → (still garbled) → defer to caller-ID with name_status=unresolved, honest line, NEVER a guessed name and NEVER a silent nameless book", async () => {
    // Four DISTINCT ascending count-runs — the exact STT failure mode from the real
    // call — delivered at the name step. The degenerate guard routes them through the
    // hierarchy (re-ask → spell → spell-again → defer), never straight to a book.
    const f1 = "1, 2, 3, 4, 5, 6, 7, 8, 9, 10";
    const f2 = "11, 12, 13, 14, 15, 16, 17, 18, 19, 20";
    const f3 = "21, 22, 23, 24, 25, 26, 27, 28, 29, 30";
    const f4 = "31, 32, 33, 34, 35, 36, 37, 38, 39, 40";
    const m = await brain({
      "book a table for four this Saturday at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "this Saturday"), ...ent("time", "seven") } }),
    }, "+61400555220");
    m.opening();
    const askName = await m.next("book a table for four this Saturday at seven");
    expect(askName.say).toMatch(/name/i);                 // slot complete → asks the name
    const r1 = await m.next(f1);
    expect(r1.say).toMatch(/catch the name|say it once more|didn'?t catch/i); // 1) re-ask
    expect(r1.kind).not.toBe("abandoned");
    const r2 = await m.next(f2);
    expect(r2.say).toMatch(/spell/i);                     // 2) ask to spell
    const r3 = await m.next(f3);
    expect(r3.say).toMatch(/spell/i);                     // still garbled → spell again
    const r4 = await m.next(f4);                          // exhausted → defer with caller-ID
    expect(r4.say).toMatch(/trouble catching the name/i); // honest fallback line
    expect(r4.say).toMatch(/got your number|under that|flag the name/i);
    expect(r4.kind).not.toBe("abandoned");
    expect(r4.endCall).toBeFalsy();                       // never a hang-up
    // Booked, under the caller's number, name UNRESOLVED and flagged — never invented.
    expect(m.reservation).not.toBeNull();
    expect(m.reservation?.customerPhone).toBe("+61400555220");
    expect(m.reservation?.nameStatus).toBe("unresolved");
    expect(m.reservation?.needsStaffAttention).toBe(true);
    expect(m.reservation?.customerName ?? "").toBe("");   // no guessed/garbage name
    expect(m.reservation?.status).toBe("CONFIRMED");
  });

  it("if the caller successfully SPELLS the name, it is captured (name_status=provided), not deferred", async () => {
    const flood = "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12";
    const m = await brain({
      "book a table for two next Friday at half six": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "next Friday"), ...ent("time", "half six") } }),
      "Z A R A": I(),  // a clean spelling, parsed from the raw text
      "yes": I({ confirmation: true }),
    }, "+61400555221");
    m.opening();
    await m.next("book a table for two next Friday at half six"); // asks name
    await m.next(flood);                                          // garbled → re-ask
    const spellAsk = await m.next(flood);                         // garbled → ask to spell
    expect(spellAsk.say).toMatch(/spell/i);
    const spelled = await m.next("Z A R A");                      // spelled → confirm
    expect(spelled.say).toMatch(/zara/i);
    await m.next("yes");                                          // confirm the name
    const done = await m.next("yes");                             // confirm the booking
    expect(done.kind).toBe("confirmed");
    expect(m.reservation?.customerName).toBe("Zara");
    expect(m.reservation?.nameStatus).toBe("provided");
    expect(m.reservation?.needsStaffAttention).toBe(false);
  });

  it("a normal booking stores name_status=provided and matches the persisted DB row (consistency gate)", async () => {
    const m = await brain({
      "table for four on December 15th at seven, name Kevin": I({
        primary_intent: "NEW_RESERVATION",
        entities: { ...ent("party_size", "four"), ...ent("date", "December 15th"), ...ent("time", "seven"), ...ent("name", "Kevin") },
      }),
      "yes": I({ confirmation: true }),
    }, "+61400555222");
    m.opening();
    await m.next("table for four on December 15th at seven, name Kevin");
    const done = await m.next("yes");
    expect(done.kind).toBe("confirmed");
    const r = m.reservation!;
    expect(r.nameStatus).toBe("provided");
    expect(r.needsStaffAttention).toBe(false);
    // Sally's confirmation came from the persisted record — re-read it and confirm the
    // spoken fields match exactly (date/time/party/name), the consistency gate's point.
    const persisted = (await findReservations(db, tctx.restaurant.id, "+61400555222"))[0]!;
    expect(persisted.partySize).toBe(4);
    expect(persisted.reservationDate).toBe("2026-12-15");
    expect(persisted.reservationTime.slice(0, 5)).toBe("19:00");
    expect(persisted.customerName).toBe("Kevin");
    expect(done.say).toMatch(/Kevin/);
  });
});

describe("conversational brain — FAST-PATH never cross-contaminates fields (Kevin 2026-10-10 acceptance)", () => {
  it("'three people' answered when we asked the TIME is captured as PARTY, never read as 3 o'clock", async () => {
    const m = await brain({
      "December 15th": I({ primary_intent: "NEW_RESERVATION", entities: ent("date", "December 15th") }),
      "three people": I({ entities: ent("party_size", "three people") }), // LLM attributes it as party
    }, "+61400557001");
    m.opening();
    await m.next("December 15th");       // date set → asks time
    await m.next("three people");         // we asked time, but this is a PARTY
    const d = m.debug().draft;
    expect(d.partySize).toBe(3);          // captured as party
    expect(d.time).toBeUndefined();       // NOT misread as 3 o'clock
  });

  it("'eight o'clock' answered when we asked the PARTY is a TIME, never read as party 8", async () => {
    const m = await brain({
      "December 15th": I({ primary_intent: "NEW_RESERVATION", entities: ent("date", "December 15th") }),
      "at seven": I({ entities: ent("time", "at seven") }),
      "eight o'clock": I({ entities: ent("time", "eight o'clock") }), // a time, even though party was asked
    }, "+61400557002");
    m.opening();
    await m.next("December 15th");
    await m.next("at seven");              // time set → asks party
    await m.next("eight o'clock");         // we asked party, but this is a TIME
    const d = m.debug().draft;
    expect(d.partySize).toBeUndefined();   // NOT misread as party 8
    expect(d.time).toBe("20:00");          // captured/updated as the time
  });

  it("a combined 'six thirty, three people, name Ivy' answer to the time question keeps ALL three", async () => {
    const m = await brain({
      "next Friday": I({ primary_intent: "NEW_RESERVATION", entities: ent("date", "next Friday") }),
      "six thirty, three people, name Ivy": I({ entities: { ...ent("time", "six thirty"), ...ent("party_size", "three people"), ...ent("name", "Ivy") } }),
    }, "+61400557003");
    m.opening();
    await m.next("next Friday");
    await m.next("six thirty, three people, name Ivy");
    const d = m.debug().draft;
    expect(d.time).toBe("18:30");
    expect(d.partySize).toBe(3);
    expect(d.name).toBe("Ivy");
  });
});

describe("conversational brain — 'that's all right' is a confirmation, not a hang-up (Kevin 2026-10-10)", () => {
  it("'yes, that's all right' at the final confirm BOOKS, never ends the call", async () => {
    const m = await brain({
      "table for four on December 15th at seven, name Gabe": I({
        primary_intent: "NEW_RESERVATION",
        entities: { ...ent("party_size", "four"), ...ent("date", "December 15th"), ...ent("time", "seven"), ...ent("name", "Gabe") },
      }),
      "yes, that's all right": I({ confirmation: true }),
    }, "+61400557004");
    m.opening();
    await m.next("table for four on December 15th at seven, name Gabe");
    const done = await m.next("yes, that's all right");
    expect(done.kind).toBe("confirmed");   // booked
    expect(done.endCall).toBeFalsy();      // did NOT hang up on "that's all right"
    expect(m.reservation?.partySize).toBe(4);
  });
});

describe("conversational brain — a name spelled in the SAME breath stores the clean name (Kevin 2026-10-10)", () => {
  it("'it's Zara, Z-A-R-A' stores 'Zara', never 'Zara Z-a-r-a'", async () => {
    const m = await brain({
      "Saturday at seven for two": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("date", "Saturday"), ...ent("time", "seven"), ...ent("party_size", "two") } }),
      "it's Zara, Z-A-R-A": I({ entities: ent("name", "it's Zara, Z-A-R-A") }),
      "yes": I({ confirmation: true }),
    }, "+61400557005");
    m.opening();
    await m.next("Saturday at seven for two");
    const nm = await m.next("it's Zara, Z-A-R-A");
    expect(nm.say).toMatch(/zara/i);
    expect(nm.say).not.toMatch(/z-a-r-a/i);
    const done = await m.next("yes");
    if (done.kind !== "confirmed") await m.next("yes");
    expect(m.reservation?.customerName).toBe("Zara");
  });
});

describe("conversational brain — a note added AFTER booking is PERSISTED (Kevin 2026-10-10 dangerous scenario)", () => {
  it("an occasion mentioned after 'booked' is saved to the record, not just acknowledged", async () => {
    const m = await brain({
      "four on December 15th at seven, name Theo": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "December 15th"), ...ent("time", "seven"), ...ent("name", "Theo") } }),
      "yes": I({ confirmation: true }),
      "oh, it's my wife's birthday": I({ occasion: "my wife's birthday" }),
    }, "+61400559001");
    m.opening();
    await m.next("four on December 15th at seven, name Theo");
    await m.next("yes");                                   // booked
    expect(m.reservation?.specialRequests ?? "").not.toMatch(/birthday/i); // not yet
    const occ = await m.next("oh, it's my wife's birthday"); // after booking
    expect(occ.endCall).toBeFalsy();                       // stays on the line
    expect(m.reservation?.specialRequests).toMatch(/birthday/i); // PERSISTED to the DB row
  });

  it("a party change after 'booked' updates the persisted record", async () => {
    const m = await brain({
      "two on December 15th at seven, name Uri": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "December 15th"), ...ent("time", "seven"), ...ent("name", "Uri") } }),
      "yes": I({ confirmation: true }),
      "actually make it five": I({ corrections: [corr("party_size", "five")] }),
    }, "+61400559002");
    m.opening();
    await m.next("two on December 15th at seven, name Uri");
    await m.next("yes");
    await m.next("actually make it five");
    expect(m.reservation?.partySize).toBe(5);              // DB row reflects the change
  });
});

describe("conversational brain — LIVE-CALL REGRESSIONS (Kevin 2026-10-10 real India-line calls)", () => {
  it("'half past eleven' at an evening venue books 23:30, never loops as a closed 11:30 AM", async () => {
    const m = await brain({
      "December 15th": I({ primary_intent: "NEW_RESERVATION", entities: ent("date", "December 15th") }),
      "half past eleven": I({ entities: ent("time", "half past eleven") }),
      "two people, name Priya": I({ entities: { ...ent("party_size", "two people"), ...ent("name", "Priya") } }),
      "yes": I({ confirmation: true }),
    }, "+61400559101");
    m.opening();
    await m.next("December 15th");
    const t = await m.next("half past eleven");
    expect(t.say).not.toMatch(/what time|open from .* till/i); // did NOT reject as out-of-hours
    expect(m.debug().draft.time).toBe("23:30");
    await m.next("two people, name Priya");
    const done = await m.next("yes");
    if (done.kind !== "confirmed") await m.next("yes");
    expect(m.reservation?.reservationTime.slice(0, 5)).toBe("23:30");
  });

  it("a YES to the lock-in BOOKS even when phrased with an end-like clause ('yeah, I'm good')", async () => {
    const m = await brain({
      "four on December 15th at seven, name Ora": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "December 15th"), ...ent("time", "seven"), ...ent("name", "Ora") } }),
      // The LLM might even read "I'm good" as an end — the deterministic affirm-guard must win.
      "yeah, I'm good": I({ request_to_end_call: true }),
    }, "+61400559102");
    m.opening();
    await m.next("four on December 15th at seven, name Ora");
    const done = await m.next("yeah, I'm good");
    expect(done.kind).toBe("confirmed");       // booked, NOT a goodbye
    expect(done.endCall).toBeFalsy();
    expect(m.reservation?.partySize).toBe(4);
  });

  it("'when are you open?' is ANSWERED with the real hours, not deflected", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "when are you open?": I({ primary_intent: "ASK_QUESTION", customer_question: "when are you open?" }),
    }, "+61400559103");
    m.opening();
    await m.next("book a table");
    const q = await m.next("when are you open?");
    expect(q.say).toMatch(/open from/i);
    expect(q.say).toMatch(/5|five/);           // states the real opening time (17:00 → 5 PM)
    expect(q.endCall).toBeFalsy();
  });
});

describe("conversational brain — FINAL CALL-ENDING MATRIX (Kevin 2026-10-10 acceptance)", () => {
  it("'thanks, bye' after a booking MAY end", async () => {
    const m = await brain({
      "four on December 15th at seven, name Bea": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "December 15th"), ...ent("time", "seven"), ...ent("name", "Bea") } }),
      "yes": I({ confirmation: true }),
      "thanks, bye": I({ request_to_end_call: true }),
    }, "+61400558001");
    m.opening();
    await m.next("four on December 15th at seven, name Bea");
    await m.next("yes");
    const bye = await m.next("thanks, bye");
    expect(bye.endCall).toBe(true);
  });

  it("a bare 'no' answering a field question must NOT end the call", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "no": I({ negation: true }),
    }, "+61400558002");
    m.opening();
    await m.next("book a table");          // asks a detail
    const r = await m.next("no");          // a bare no — NOT a close
    expect(r.endCall).toBeFalsy();
    expect(r.kind).not.toBe("goodbye");
  });

  it("'no, make it six' is a correction and continues (never an end)", async () => {
    const m = await brain({
      "table for four this Saturday at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "this Saturday"), ...ent("time", "seven") } }),
      "no, make it six": I({ negation: true, corrections: [corr("party_size", "six")] }),
    }, "+61400558003");
    m.opening();
    await m.next("table for four this Saturday at seven");
    const r = await m.next("no, make it six");
    expect(r.endCall).toBeFalsy();
    expect(r.say).toMatch(/\b6\b|six/);
    expect(m.debug().draft.partySize).toBe(6);
  });

  it("'never mind, I don't want the booking' MAY abandon", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "never mind, I don't want the booking": I({ primary_intent: "ABANDON" }),
    }, "+61400558004");
    m.opening();
    await m.next("book a table");
    const r = await m.next("never mind, I don't want the booking");
    expect(r.kind).toBe("abandoned");
    expect(r.endCall).toBe(true);
  });

  it("'hold on' waits (no end)", async () => {
    const m = await brain({
      "book a table for two this Saturday": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "two"), ...ent("date", "this Saturday") } }),
      "hold on": I({ request_to_wait: true }),
    }, "+61400558005");
    m.opening();
    await m.next("book a table for two this Saturday");
    const r = await m.next("hold on");
    expect(r.kind).toBe("hold");
    expect(r.endCall).toBeFalsy();
  });

  it("a frustrated customer is NEVER hung up on", async () => {
    const m = await brain({
      "table for four Friday at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "Friday"), ...ent("time", "seven") } }),
      "this is ridiculous, you keep asking me the same thing": I({ frustrated: true }),
    }, "+61400558006");
    m.opening();
    await m.next("table for four Friday at seven");
    const r = await m.next("this is ridiculous, you keep asking me the same thing");
    expect(r.endCall).toBeFalsy();
    expect(r.kind).not.toBe("goodbye");
    expect(r.kind).not.toBe("abandoned");
  });

  it("a large group is offered a call-back and the line stays open for a final turn", async () => {
    const m = await brain({
      "I need a table for 25 next Saturday at seven": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "25"), ...ent("date", "next Saturday"), ...ent("time", "seven") } }),
      "ok thanks": I({}),
    }, "+61400558007");
    m.opening();
    const big = await m.next("I need a table for 25 next Saturday at seven");
    expect(big.endCall).toBeFalsy();                 // never hangs up on a big group
    const after = await m.next("ok thanks");         // a final customer turn is allowed
    expect(after.endCall).toBeFalsy();
  });

  it("after a booking, 'can you repeat it?' reads it back and stays responsive", async () => {
    const m = await brain({
      "four on December 15th at seven, name Cy": I({ primary_intent: "NEW_RESERVATION", entities: { ...ent("party_size", "four"), ...ent("date", "December 15th"), ...ent("time", "seven"), ...ent("name", "Cy") } }),
      "yes": I({ confirmation: true }),
      "can you repeat it?": I({ request_to_repeat: true }),
    }, "+61400558008");
    m.opening();
    await m.next("four on December 15th at seven, name Cy");
    await m.next("yes");
    const rep = await m.next("can you repeat it?");
    expect(rep.endCall).toBeFalsy();
    expect(rep.say).toMatch(/\b4\b|four/);
    expect(rep.say).toMatch(/cy/i);
  });
});

describe("conversational brain — abandonment", () => {
  it("drops the booking on 'forget it' and ends warmly without booking", async () => {
    const m = await brain({
      "book a table": I({ primary_intent: "NEW_RESERVATION" }),
      "actually forget it": I({ primary_intent: "ABANDON" }),
    }, "+61400555014");
    m.opening();
    await m.next("book a table");
    const bye = await m.next("actually forget it");
    expect(bye.endCall).toBe(true);
    expect(m.reservation).toBeNull();
    expect((await findReservations(db, tctx.restaurant.id, "+61400555014")).length).toBe(0);
  });
});
