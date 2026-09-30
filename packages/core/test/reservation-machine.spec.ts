import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext } from "../src/agent/reservation-machine";
import { getReservationSettings, findReservations, createReservation } from "../src/domain/reservations";
import { normaliseDate } from "../src/domain/reservation-time";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

let ctx: TestContext;
let db: pg.Pool;
const TZ = "Australia/Perth";
const NOW = new Date();
const DATE = normaliseDate("2026-12-15", { now: NOW, timezone: TZ }).date!;

beforeAll(async () => { ctx = await setupTestDb(); db = ctx.db; });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

async function machine(callerPhone: string | null = "+61400555001"): Promise<ReservationMachine> {
  const rc: ReservationContext = {
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: ctx.hours,
    settings: await getReservationSettings(db, ctx.restaurant.id), timezone: TZ,
    now: () => NOW, callerPhone: callerPhone ?? undefined,
    address: ctx.restaurant.address, phoneDisplay: ctx.restaurant.phoneDisplay,
  };
  return new ReservationMachine(rc);
}

describe("ReservationMachine — booking flow", () => {
  it("books a table through a short natural conversation", async () => {
    const m = await machine();
    expect(m.opening()).toMatch(/book a table/i);
    let t = await m.next("I'd like to book a table");
    expect(t.kind).toBe("ask_date");
    t = await m.next(DATE); // "what day"
    expect(t.kind).toBe("ask_time");
    t = await m.next("seven");
    expect(t.kind).toBe("ask_party");
    t = await m.next("four");
    expect(t.kind).toBe("ask_name");
    t = await m.next("Kevin");
    // caller ID present, so it finalises without asking phone
    expect(t.kind).toBe("confirmed");
    expect(t.say).toMatch(/booked for 4/i);
    expect(t.say).toMatch(/7 PM/);
    expect(t.endCall).toBe(true);
    expect(m.reservation?.status).toBe("CONFIRMED");
    expect(m.reservation?.customerName).toBe("Kevin");
    expect(m.reservation?.partySize).toBe(4);
    const saved = await findReservations(db, ctx.restaurant.id, "+61400555001");
    expect(saved.length).toBe(1);
  });

  it("extracts date + party from the opener, still asks the time", async () => {
    const m = await machine();
    const t = await m.next("a table for four this Saturday");
    expect(t.kind).toBe("ask_time");
  });

  it("asks for a mobile when there's no caller ID", async () => {
    const m = await machine(null);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    let t = await m.next("Kevin");
    expect(t.kind).toBe("ask_phone");
    t = await m.next("0412 345 678");
    expect(t.kind).toBe("confirmed");
    expect(m.reservation?.customerPhone).toBe("+61412345678");
  });

  it("handles 'seat reservation' phrasing", async () => {
    const m = await machine();
    let t = await m.next("I'd like to reserve a seat");
    expect(t.kind).toBe("ask_date");
    t = await m.next(DATE);
    t = await m.next("seven");
    t = await m.next("seats for two");
    expect(t.kind).toBe("ask_name");
  });

  it("enqueues a customer SMS from the stored record when SMS is enabled (§43)", async () => {
    const rc: ReservationContext = {
      db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: ctx.hours,
      settings: await getReservationSettings(db, ctx.restaurant.id), timezone: TZ,
      now: () => NOW, callerPhone: "+61400556001", customerSmsEnabled: true,
    };
    const m = new ReservationMachine(rc);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    const t = await m.next("Kevin");
    expect(t.kind).toBe("confirmed");
    // SMS is fire-and-forget; give the enqueue a moment.
    await new Promise((r) => setTimeout(r, 100));
    const sms = await db.query(
      `SELECT kind, to_number, body FROM notification_attempts WHERE kind='customer_sms' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(sms.rows[0]?.kind).toBe("customer_sms");
    expect(String(sms.rows[0]?.body)).toMatch(/booking confirmed/i);
    expect(String(sms.rows[0]?.to_number)).toBe("+61400556001");
  });

  it("declines a food order and steers back to booking", async () => {
    const m = await machine();
    const t = await m.next("I want to order two burgers");
    expect(t.kind).toBe("decline_food");
    expect(t.say.toLowerCase()).toContain("reservation");
  });

  it("declines takeaway", async () => {
    const m = await machine();
    expect((await m.next("I need takeaway")).kind).toBe("decline_food");
  });

  it("escalates a party that's too large", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    const t = await m.next("twenty");
    expect(t.kind).toBe("escalate_party");
    expect(t.say).toMatch(/call you back/i);
  });

  it("offers alternatives when the slot is full", async () => {
    await db.query(`UPDATE reservation_settings SET max_covers_per_slot = 4, turnover_minutes = 15`);
    await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "A", customerPhone: "+61400999000",
      date: DATE, time: "19:00", partySize: 4,
    });
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    const t = await m.next("two");
    expect(t.kind).toBe("alternatives");
    expect(t.say).toMatch(/booked out/i);
  });

  it("captures party from an STT time-rendering '4:00' and a trailing period (live call 8d55f5f8)", async () => {
    for (const partyText of ["4:00", "Four.", "about four", "4:00."]) {
      const m = await machine();
      await m.next("book a table");
      await m.next(DATE);
      await m.next("eight");
      const t = await m.next(partyText);
      expect(t.kind, partyText).toBe("ask_name"); // party captured -> availability OK -> ask name
    }
  });

  it("escalates after 3 unparseable party answers instead of looping (§27/§28)", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("eight");
    await m.next("blah");
    await m.next("blah");
    const t = await m.next("blah");
    expect(t.kind).toBe("escalate_name");
    // and completing escalation never claims a booking
    const done = await m.next("Kevin");
    expect(done.kind).toBe("escalated");
    expect(m.reservation).toBeNull();
  });

  it("handles a party correction mid-flow", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    let t = await m.next("seven, actually make it two");
    // party captured via correction -> goes straight to availability -> name
    expect(["ask_name", "ask_party"]).toContain(t.kind);
  });

  // ------------------------------------------------------ the exact failed call

  it("REPLAY of the reported failed call — 'About four' / 'Four' must NOT loop (spec §26)", async () => {
    // Reproduces Kevin's transcript: today / about 8 PM / 'about four' / 'four'.
    const m = await machine();
    await m.next("I want to book a table");
    const said: string[] = [];
    let t = await m.next("today");
    said.push(t.say);
    expect(t.kind).toBe("ask_time");
    t = await m.next("about 8 PM");
    said.push(t.say);
    expect(t.kind).toBe("ask_party");
    // The line that used to loop five times:
    t = await m.next("about four");
    said.push(t.say);
    // party is understood immediately -> availability -> name. NOT another party ask.
    expect(t.kind).toBe("ask_name");
    // And the assistant NEVER said "Sorry, how many people?" even once.
    expect(said.join(" ")).not.toMatch(/sorry, how many/i);
  });

  it("STT returns the homophone 'for' -> confirms 'Four people?' -> yes -> books (spec §2, §8)", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("eight");
    let t = await m.next("for"); // STT wrote "for" for "four"
    expect(t.kind).toBe("confirm_party");
    expect(t.say).toMatch(/four people\?/i);
    t = await m.next("yes");
    expect(t.kind).toBe("ask_name"); // party resolved, moved on
  });

  it("candidate confirm accepts a corrected number instead of yes/no", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("eight");
    let t = await m.next("for");
    expect(t.kind).toBe("confirm_party");
    t = await m.next("no, five"); // correct it during the confirm
    expect(t.kind).toBe("ask_name");
    // and it booked five, not four
    t = await m.next("Kevin");
    expect(m.reservation?.partySize).toBe(5);
  });

  it("'four or five' asks which, then books the chosen one (spec §23)", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("eight");
    let t = await m.next("four or five");
    expect(t.say).toMatch(/four or five/i);
    expect(t.kind).toBe("ask_party");
    t = await m.next("five");
    expect(t.kind).toBe("ask_name");
    await m.next("Kevin");
    expect(m.reservation?.partySize).toBe(5);
  });

  it("party recovery escalates strategy: reword -> keypad hint -> call-back (spec §5)", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("eight");
    const kinds: string[] = [];
    kinds.push((await m.next("blah")).kind); // reword
    kinds.push((await m.next("blah")).kind); // keypad hint
    kinds.push((await m.next("blah")).kind); // call-back
    expect(kinds).toEqual(["ask_party", "ask_party_dtmf", "escalate_name"]);
  });

  it("never repeats the identical party question twice in a row (spec §4)", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    const first = (await m.next("eight")).say; // "How many people?"
    const second = (await m.next("blah")).say; // reworded
    const third = (await m.next("blah")).say; // keypad
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    // and none of the party prompts start with "Sorry" (spec §6)
    for (const s of [first, second, third]) expect(s).not.toMatch(/^sorry/i);
  });

  it("a keypad digit answers the party question (DTMF fallback fed as text, spec §5)", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("eight");
    const t = await m.next("4"); // Twilio DTMF '4' arrives as the utterance "4"
    expect(t.kind).toBe("ask_name");
  });

  it("accepts all details in one opener and jumps to availability (spec §14)", async () => {
    const m = await machine();
    const iso = DATE;
    // Use an explicit date word + time + party in one sentence.
    const t = await m.next(`a table for four tomorrow at eight`);
    // date+party+time all captured -> straight to name (availability passed)
    // (tomorrow relative to NOW; time 8 PM; party 4)
    expect(["ask_name", "ask_phone", "confirmed"]).toContain(t.kind);
    void iso;
  });

  it("gentleReprompt re-asks the current question without 'are you still there'", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("eight"); // now asking party
    const rp = m.gentleReprompt();
    expect(rp.toLowerCase()).toContain("how many");
    expect(rp.toLowerCase()).not.toContain("still there");
  });
});

describe("ReservationMachine — info layer (hours & location)", () => {
  it("answers an hours enquiry from real data, then steers to booking", async () => {
    const m = await machine();
    const t = await m.next("what are your hours?");
    expect(t.kind).toBe("info_hours");
    expect(t.say.toLowerCase()).toContain("open");
    expect(t.say.toLowerCase()).toContain("book a table");
  });

  it("answers a location enquiry", async () => {
    const m = await machine();
    const t = await m.next("where are you located?");
    expect(t.kind).toBe("info_location");
    expect(t.say.length).toBeGreaterThan(5);
  });

  it("answers an enquiry MID-booking, then the flow still continues", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE); // -> ask_time
    let t = await m.next("what time do you close?"); // enquiry mid-flow
    expect(t.kind).toBe("info_hours");
    t = await m.next("seven"); // real time answer still advances
    expect(t.kind).toBe("ask_party");
  });

  it("does not mistake a booking or a slot answer for an enquiry", async () => {
    const m = await machine();
    expect((await m.next("I'd like to book a table")).kind).toBe("ask_date");
    expect((await m.next(DATE)).kind).toBe("ask_time");
    expect((await m.next("seven")).kind).toBe("ask_party");
    expect((await m.next("four")).kind).toBe("ask_name"); // "four" not seen as an enquiry
  });
});

describe("ReservationMachine — cancel & modify", () => {
  async function seedBooking(phone: string) {
    return (await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "Kevin", customerPhone: phone,
      date: DATE, time: "19:00", partySize: 4,
    })).reservation;
  }

  it("cancels an existing booking after confirmation", async () => {
    await seedBooking("+61400555010");
    const m = await machine("+61400555010");
    let t = await m.next("I need to cancel my booking");
    expect(t.kind).toBe("cancel_confirm");
    t = await m.next("yes please");
    expect(t.kind).toBe("cancelled");
    expect((await findReservations(db, ctx.restaurant.id, "+61400555010")).length).toBe(0);
  });

  it("keeps the booking if the caller says no to cancelling", async () => {
    await seedBooking("+61400555011");
    const m = await machine("+61400555011");
    await m.next("cancel my table");
    const t = await m.next("no, leave it");
    expect(t.kind).toBe("keep");
    expect((await findReservations(db, ctx.restaurant.id, "+61400555011")).length).toBe(1);
  });

  it("confirms an existing booking", async () => {
    await seedBooking("+61400555012");
    const m = await machine("+61400555012");
    const t = await m.next("can you confirm my reservation");
    expect(t.kind).toBe("confirm_existing");
    expect(t.say).toMatch(/booked/i);
  });

  it("modifies the party size of an existing booking", async () => {
    await seedBooking("+61400555013");
    const m = await machine("+61400555013");
    let t = await m.next("I want to change my booking");
    expect(t.kind).toBe("modify_what");
    t = await m.next("make it 6 people");
    expect(t.kind).toBe("modified");
    const updated = await findReservations(db, ctx.restaurant.id, "+61400555013");
    expect(updated[0]!.partySize).toBe(6);
  });

  it("tells the caller to call from the booking number when there's no caller ID", async () => {
    const m = await machine(null);
    const t = await m.next("cancel my booking");
    expect(t.kind).toBe("no_caller_id");
  });
});
