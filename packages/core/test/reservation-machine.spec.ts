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

async function machine(callerPhone: string | null = "+61400555001", nowOverride?: Date): Promise<ReservationMachine> {
  const rc: ReservationContext = {
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: ctx.hours,
    settings: await getReservationSettings(db, ctx.restaurant.id), timezone: TZ,
    now: () => nowOverride ?? NOW, callerPhone: callerPhone ?? undefined,
    address: ctx.restaurant.address, phoneDisplay: ctx.restaurant.phoneDisplay,
  };
  return new ReservationMachine(rc);
}
// A fixed mid-morning clock for tests that say "today … <evening time>" — so the
// time is always in the future regardless of the wall-clock the suite runs at
// (otherwise "today 8 PM" is treated as past when run after ~8 PM). Monday 10:00 Perth.
const MORNING = new Date("2026-10-05T02:00:00Z");

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
    // caller ID present -> offers to use the number they're calling from
    expect(t.kind).toBe("confirm_phone");
    t = await m.next("yes");
    // phone accepted → straight to the confirm beat (no separate preferences question —
    // Kevin 2026-10-07: "no need [for those] questions"). Details were confirmed as we
    // went; the booking is only re-read if the caller asks.
    expect(t.kind).toBe("confirm_booking");
    expect(t.say).toMatch(/lock (it|that) in/i);
    expect(t.say).not.toMatch(/for four/i); // no full re-read here
    t = await m.next("yes please");
    expect(t.kind).toBe("confirmed");
    expect(t.say).toMatch(/booked/i);
    // stays on the line so the caller can change or cancel in the same call
    expect(t.endCall).toBe(false);
    expect(m.reservation?.status).toBe("CONFIRMED");
    expect(m.reservation?.customerName).toBe("Kevin");
    expect(m.reservation?.partySize).toBe(4);
    const saved = await findReservations(db, ctx.restaurant.id, "+61400555001");
    expect(saved.length).toBe(1);
    // caller rings off -> booking stands, call ends
    t = await m.next("no that's all");
    expect(t.kind).toBe("goodbye");
    expect(t.endCall).toBe(true);
    expect((await findReservations(db, ctx.restaurant.id, "+61400555001")).length).toBe(1);
  });

  // Kevin 2026-10-08: after a booking's confirmed — REPEAT only when the caller asks
  // to; otherwise it's done + "anything else?"; and any change they ask for is made.
  async function bookToPostConfirm(phone: string): Promise<ReservationMachine> {
    const m = await machine(phone);
    await m.next("book a table"); await m.next(DATE); await m.next("seven"); await m.next("four");
    await m.next("Kevin"); await m.next("yes"); // caller ID -> confirm beat
    const done = await m.next("yes please");     // -> confirmed, POST_CONFIRM
    expect(done.kind).toBe("confirmed");
    return m;
  }
  it("post-confirm: REPEAT only when asked, else 'done + anything else', and changes are applied", async () => {
    // (a) An explicit repeat → reads the booking back, then "anything else".
    const m1 = await bookToPostConfirm("+61400555090");
    const rep = await m1.next("can you repeat the reservation?");
    expect(rep.kind).toBe("repeat");
    expect(rep.say).toMatch(/\b4\b/);                    // reads the party size back
    expect(rep.say).toMatch(/Kevin/);
    expect(rep.say).toMatch(/anything else/i);
    expect(rep.endCall).toBeFalsy();

    // (b) A NON-repeat, non-change, non-done reply does NOT read back — just "anything else".
    const m2 = await bookToPostConfirm("+61400555091");
    const other = await m2.next("hmm");
    expect(other.kind).toBe("anything_else");
    expect(other.say).not.toMatch(/I've got you down for/i); // not a full read-back

    // (c) A change is MADE.
    const m3 = await bookToPostConfirm("+61400555092");
    const ch = await m3.next("actually make it six");
    expect(ch.kind).toBe("modified");
    expect(m3.reservation?.partySize).toBe(6);

    // (d) "That's all" → done, ends warmly (no loop).
    const m4 = await bookToPostConfirm("+61400555093");
    const bye = await m4.next("no that's all, thanks");
    expect(bye.kind).toBe("goodbye");
    expect(bye.endCall).toBe(true);
  });

  // Live India call 2026-10-08 ("very bad"): the caller asked "can you change the
  // date?" repeatedly at the NAME step; it was mistaken for a failed name and the
  // booking went under "Guest" with the wrong date. A change request must be honoured
  // at ANY point — re-open the slot, or apply a value given in the same breath.
  it("'change the date' at the name step re-opens the date (not mistaken for a name)", async () => {
    const m = await machine("+61400555095", MORNING); // pin NOW: "this Saturday"/"next Sunday" must not depend on wall-clock time-of-day
    await m.next("book a table"); await m.next("this Saturday"); await m.next("seven"); await m.next("four");
    // now at the NAME step
    const t = await m.next("can you change the date?");
    expect(t.kind).toBe("ask_date");
    expect(t.say).toMatch(/what day/i);
    expect(m.debug().draft.name).toBeUndefined();   // NOT booked/stored as a name
    const t2 = await m.next("next Sunday");          // new day → proceeds (time+party already set → name)
    expect(t2.kind).toBe("ask_name");
    expect(new Date(m.debug().draft.date! + "T00:00:00Z").getUTCDay()).toBe(0); // Sunday
  });

  it("'change the date to next month the 14th' at the confirm beat applies the new date", async () => {
    const m = await machine("+61400555096", MORNING); // NOW = Mon 5 Oct 2026
    await m.next("book a table"); await m.next("this Saturday"); await m.next("seven"); await m.next("four");
    await m.next("Kevin"); await m.next("yes");       // -> confirm beat
    const t = await m.next("can you change the date to next month the fourteenth?");
    // re-checked and re-confirmed with the new date (November)
    expect(["confirm_booking", "ask_time", "ask_party"]).toContain(t.kind);
    expect(m.debug().draft.date).toBe("2026-11-14");
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
    expect(t.kind).toBe("confirm_booking");
    t = await m.next("yes please");
    expect(t.kind).toBe("confirmed");
    expect(m.reservation?.customerPhone).toBe("+61412345678");
  });

  it("offers the number you're calling from, and 'yes' uses it (Kevin: accept the caller ID)", async () => {
    const m = await machine("+61400555050");
    await m.next("book a table"); await m.next(DATE); await m.next("seven"); await m.next("four");
    let t = await m.next("Kevin");
    expect(t.kind).toBe("confirm_phone");
    expect(t.say.toLowerCase()).toMatch(/calling from/);
    t = await m.next("yes");
    expect(t.kind).toBe("confirm_booking");
    await m.next("yes please");
    expect(m.reservation?.customerPhone).toBe("+61400555050");
  });

  it("a different number given at the phone-confirm is used instead of the caller ID", async () => {
    const m = await machine("+61400555051");
    await m.next("book a table"); await m.next(DATE); await m.next("seven"); await m.next("four");
    await m.next("Kevin");
    const t = await m.next("no, use 0412 345 678");
    expect(t.kind).toBe("confirm_booking");
    await m.next("yes please");
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
    let t = await m.next("Kevin");
    expect(t.kind).toBe("confirm_phone");
    t = await m.next("yes");
    expect(t.kind).toBe("confirm_booking");
    t = await m.next("yes please");
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
    expect(t.say).toMatch(/call you (straight |right )?back|team/i);
    expect(t.say).toMatch(/group of 20|twenty/i); // reads the group size back (confirmation)
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
    // name is READ BACK for a confirm beat (not an instant hang-up, Kevin 2026-10-08)
    const back = await m.next("Kevin");
    expect(back.kind).toBe("escalate_confirm");
    expect(back.say).toMatch(/Kevin/);
    expect(back.endCall).toBeFalsy();
    // confirmed → completes; and completing escalation never claims a booking
    const done = await m.next("yes");
    expect(done.kind).toBe("escalated");
    expect(done.endCall).toBe(true);
    expect(m.reservation).toBeNull();
  });

  // Kevin 2026-10-08: the call-back confirm must let a MIS-HEARD name be corrected
  // (large-party call "Zuzane" ended too fast). Spell at the confirm beat → fixed.
  it("a mis-heard call-back name can be corrected at the confirm beat (not a fast hang-up)", async () => {
    const m = await machine("+61400555080", MORNING);
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    const big = await m.next("twenty five people");  // too large → escalate
    expect(big.kind).toMatch(/escalate/);
    const back = await m.next("Youssef");           // heard name → read back, NOT ended
    expect(back.kind).toBe("escalate_confirm");
    expect(back.endCall).toBeFalsy();
    const sp = await m.next("no");                   // wrong → re-collect the name
    expect(sp.kind).toBe("escalate_name");
    const back2 = await m.next("J O S E P H");       // spelled → read back
    expect(back2.say).toMatch(/Joseph/);
    const done = await m.next("yes");
    expect(done.kind).toBe("escalated");
    expect(done.say).toMatch(/Joseph/);
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

  // ---------------------------------------------- change/cancel in the same call

  it("lets the caller CANCEL in the same call right after booking", async () => {
    const m = await machine();
    await m.next("book a table"); await m.next(DATE); await m.next("seven"); await m.next("four");
    let t = await m.next("Kevin");
    expect(t.kind).toBe("confirm_phone");
    t = await m.next("yes");
    expect(t.kind).toBe("confirm_booking");
    t = await m.next("yes please");
    expect(t.kind).toBe("confirmed");
    expect(t.endCall).toBe(false);
    expect(t.say).toMatch(/anything else|all set/i);
    t = await m.next("actually, cancel that");
    expect(t.kind).toBe("cancelled_same_call");
    expect(t.endCall).toBe(true);
    expect(m.reservation).toBeNull();
    expect((await findReservations(db, ctx.restaurant.id, "+61400555001")).length).toBe(0);
  });

  it("lets the caller CHANGE the booking in the same call", async () => {
    const m = await machine();
    await m.next("book a table"); await m.next(DATE); await m.next("seven"); await m.next("four");
    await m.next("Kevin");
    await m.next("yes");
    await m.next("yes please");
    let t = await m.next("can you change it");
    expect(t.kind).toBe("modify_what");
    t = await m.next("make it 6 people");
    expect(t.kind).toBe("modified");
    const rows = await findReservations(db, ctx.restaurant.id, "+61400555001");
    expect(rows[0]!.partySize).toBe(6);
    // "6 people" must change ONLY the party — never the date or time (the "6" must
    // not be read as the 6th or 6 PM; transcript bug 2026-10-06).
    expect(rows[0]!.reservationDate).toBe(DATE);
    expect(rows[0]!.reservationTime.slice(0, 5)).toBe("19:00");
  });

  it("keeps the booking when the caller says that's all", async () => {
    const m = await machine();
    await m.next("book a table"); await m.next(DATE); await m.next("seven"); await m.next("four");
    await m.next("Kevin");
    await m.next("yes");
    await m.next("yes please");
    const t = await m.next("no that's all");
    expect(t.kind).toBe("goodbye");
    expect(t.endCall).toBe(true);
    expect((await findReservations(db, ctx.restaurant.id, "+61400555001")).length).toBe(1);
  });

  // ------------------------------------------------------ the exact failed call

  it("REPLAY of the reported failed call — 'About four' / 'Four' must NOT loop (spec §26)", async () => {
    // Reproduces Kevin's transcript: today / about 8 PM / 'about four' / 'four'.
    // Pinned to a morning clock so "today 8 PM" is always future (was flaky after 8 PM).
    const m = await machine("+61400555001", MORNING);
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
    await m.next("Kevin");
    await m.next("yes");
    await m.next("yes please");
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
    await m.next("yes");
    await m.next("yes please");
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

  it("captures a time given with the day ('tomorrow at 5 pm') — no redundant time question", async () => {
    const m = await machine();
    await m.next("book a table");
    const t = await m.next("tomorrow at 5 p.m."); // day + time together
    expect(t.kind).toBe("ask_party"); // time captured, so it jumps to party
  });

  it("captures day + time + explicit party together at the day step", async () => {
    const m = await machine();
    await m.next("book a table");
    const t = await m.next("tomorrow at 7 for four people"); // all three
    expect(t.kind).toBe("ask_name"); // nothing left to ask but the name
  });

  it("REPLAY live bug CA46547d: '7 PM in the afternoon for a table of five' -> 19:00 + party 5, NEVER 12 PM", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);                       // -> ask_time
    const t = await m.next("It'll be at about 7:00 PM in the afternoon for a table of five.");
    expect(t.kind).toBe("ask_name");          // time + party both captured
    expect(m.debug().draft.time).toBe("19:00"); // NOT 12:00 (afternoon≠noon)
    expect(m.debug().draft.partySize).toBe(5);  // "table of five" understood
  });

  it("captures a party said WITH the time, no re-ask ('seven, for four people')", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);                 // -> ask_time
    const t = await m.next("seven, for four people");
    expect(t.kind).toBe("ask_name");   // time 7 + party 4 both captured
  });

  it("captures party-then-time at the time step ('four people at seven')", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);                 // -> ask_time
    const t = await m.next("four people at seven");
    expect(t.kind).toBe("ask_name");
  });

  it("a bare number at the day step is a DATE, never a party size", async () => {
    const m = await machine();
    await m.next("book a table");
    const t = await m.next("the 5th"); // must not be read as 5 people
    expect(["ask_time", "ask_date"]).toContain(t.kind); // moved on to time (or re-asked date), NOT party
    expect(m.debug().draft.partySize).toBeUndefined();
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

  it("speaks 24/7 hours naturally", async () => {
    const open247 = Array.from({ length: 7 }, (_, d) => ({
      id: `h${d}`, restaurantId: ctx.restaurant.id, dayOfWeek: d,
      opensAt: "00:00:00", closesAt: "23:59:00", isClosed: false,
    }));
    const m = new ReservationMachine({
      db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: open247,
      settings: await getReservationSettings(db, ctx.restaurant.id), timezone: TZ,
      now: () => NOW, callerPhone: "+61400555099",
    });
    const t = await m.next("what time do you open?");
    expect(t.say).toMatch(/24 hours a day, seven days a week/i);
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

describe("ReservationMachine — seating & dietary notes (spec §21-22)", () => {
  it("acknowledges a window-seat request mid-flow and re-asks the current question", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four"); // -> ask_name
    const t = await m.next("can we sit near the window?");
    expect(t.say.toLowerCase()).toContain("window");
    expect(t.say.toLowerCase()).toContain("name"); // re-asks the name
    expect(m.debug().draft.specialRequests).toContain("window seat");
  });

  it("captures a request said with a slot ('four, by the window') without derailing", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    const t = await m.next("four, by the window"); // party + seating together
    expect(t.kind).toBe("ask_name");               // party captured, moved on
    expect(m.debug().draft.specialRequests).toContain("window seat");
  });

  it("captures a dietary note after booking and stores it on the reservation", async () => {
    const m = await machine();
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes");
    await m.next("yes please"); // -> confirmed (POST_CONFIRM)
    const t = await m.next("oh, I'm allergic to prawns");
    expect(t.kind).toBe("note_added");
    expect(t.say.toLowerCase()).toMatch(/note|noted/); // clean ack (raw note not echoed)
    const rows = await findReservations(db, ctx.restaurant.id, "+61400555001");
    expect(rows[0]!.specialRequests.toLowerCase()).toContain("prawns"); // but stored for the kitchen
    // and the booking still stands + closes cleanly
    const done = await m.next("no that's all");
    expect(done.kind).toBe("goodbye");
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

describe("ReservationMachine — live call 2026-10-05 regressions", () => {
  // The confirm-to-lock line didn't end in "?", so the silence watchdog's
  // lastPrompt stayed on the occasion question and re-asked it, stalling the call
  // with no booking. The watchdog must re-ask the LOCK question instead.
  it("silence re-prompt at the confirm step re-asks the lock question, not the occasion", async () => {
    const m = await machine("+61400555021", MORNING);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin"); // common name -> straight to phone confirm
    const confirm = await m.next("yes"); // use caller ID -> straight to confirm
    expect(confirm.kind).toBe("confirm_booking");
    const reprompt = m.gentleReprompt();
    expect(reprompt).toMatch(/lock|change/i);
    expect(reprompt).not.toMatch(/occasion|dietary|seating/i);
  });

  // Realtime STT rendered "It's Raju" as "fix it Raju" -> it was stored "Fix Raju".
  it("captures a name from the 'fix it <name>' STT artifact", async () => {
    const m = await machine("+61400555022", MORNING);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    const t = await m.next("yeah fix it Raju");
    expect(t.kind).toBe("confirm_phone"); // Raju is trusted -> no read-back needed
    expect(m.debug().draft.name).toBe("Raju");
  });

  // A doubtful name read back and answered "no, it's correct" must NOT be stored as
  // the name "Correct" — it routes to spelling.
  it("confirm-name: 'no, it's correct' goes to spelling, never books 'Correct'", async () => {
    const m = await machine("+61400555023", MORNING);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    const rb = await m.next("Zephyrine"); // uncommon -> read-back + spell offer
    expect(rb.kind).toBe("confirm_name");
    const t = await m.next("no, it's correct");
    expect(["ask_name", "spell_name"]).toContain(t.kind); // re-say or spell, never stored
    expect(t.say).toMatch(/spell|slowly|say your/i);
    expect(m.debug().draft.name).not.toBe("Correct");
  });

  // "the same number I'm calling from" must use the caller ID, not loop asking for
  // digits (live AU call 2026-10-06 looped and escalated).
  it("'the same number I'm calling from' at phone-confirm uses the caller ID", async () => {
    const m = await machine("+61400555041", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin"); // -> confirm_phone
    const t = await m.next("the same number I'm calling from");
    expect(t.kind).toBe("confirm_booking"); // used caller ID, moved straight on
    expect(m.debug().draft.phone).toBe("+61400555041");
  });

  it("'same number' at the ask-for-a-number step also uses the caller ID", async () => {
    const m = await machine("+61400555042", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin");
    await m.next("no"); // -> COLLECT_PHONE ("what's the best number?")
    const t = await m.next("just the same number I'm calling from");
    expect(t.kind).toBe("confirm_booking");
    expect(m.debug().draft.phone).toBe("+61400555042");
  });

  // Refusing to restate the number falls back to the caller ID and still books —
  // no dead-end escalation when we already have a number (Kevin 2026-10-06).
  it("refusing to give a number falls back to the caller ID (no dead-end)", async () => {
    const m = await machine("+61400555044", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin"); // -> confirm_phone
    await m.next("no"); // -> COLLECT_PHONE
    await m.next("I don't want to"); // reask 1
    await m.next("I don't want to"); // reask 2
    const t = await m.next("I don't want to"); // reask 3 -> fall back to caller ID
    expect(["ask_extras", "confirm_booking"]).toContain(t.kind);
    expect(t.kind).not.toBe("escalate_name");
    expect(m.debug().draft.phone).toBe("+61400555044");
  });

  // A date change stated at the phone step is applied, not taken as "a different number".
  it("a date change at the phone-confirm step is applied, not mistaken for a number", async () => {
    const m = await machine("+61400555043", MORNING);
    await m.next("book a table");
    await m.next("this Friday"); // Oct 9
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin"); // -> confirm_phone
    const t = await m.next("actually, make it next week on Friday instead");
    expect(m.debug().draft.date).toBe("2026-10-16"); // this Fri Oct 9 -> next week Fri Oct 16
    expect(t.say.toLowerCase()).toMatch(/16th|change/);
  });

  // After "anything else?", a plain ack ("okay"/"thanks") ends warmly — no extra
  // "was there anything else?" loop (Kevin 2026-10-05).
  it("'okay' after 'anything else?' ends warmly, no re-ask loop", async () => {
    const m = await machine("+61400555040", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes"); // caller ID -> confirm
    await m.next("yes please"); // -> confirmed (POST_CONFIRM)
    const t = await m.next("okay"); // ack = done
    expect(t.kind).toBe("goodbye");
    expect(t.endCall).toBe(true);
    expect(t.say.toLowerCase()).not.toContain("anything else");
  });

  // A spelled-out name ("Angel, A-N-G-E-L") must book as "Angel", not "Angel A-n-g-e-l"
  // (live India call 2026-10-05).
  it("captures a spelled-out name cleanly", async () => {
    const phone = "+61400555037";
    const m = await machine(phone, MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    let t = await m.next("Angel, A-N-G-E-L");
    if (t.kind === "confirm_name") { expect(t.say).not.toMatch(/a-n-g-e-l/i); t = await m.next("yes"); }
    if (t.kind === "confirm_phone") t = await m.next("yes");
    while (t.kind === "ask_extras") t = await m.next("no thanks");
    if (t.kind === "confirm_booking") t = await m.next("yes please");
    expect(t.kind).toBe("confirmed");
    expect(m.reservation?.customerName).toBe("Angel");
  });

  // No proactive preferences question any more (Kevin 2026-10-07: "no need [for
  // those] questions, make sure it never lags") — the number step goes straight to
  // the confirm beat, keeping the call short. A volunteered preference is still
  // captured passively.
  it("goes straight from the number to confirm — no preferences question", async () => {
    const m = await machine("+61400555035", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin");
    const t = await m.next("yes"); // caller ID -> straight to confirm, no extra question
    expect(t.kind).toBe("confirm_booking");
    expect(t.say).not.toMatch(/occasion|dietary|special touches/i);
  });

  // The confirm beat just ASKS to confirm (no full re-read); "repeat that" is the
  // only thing that reads the whole booking back (Kevin 2026-10-05).
  it("confirm beat is brief; a repeat request reads the full booking", async () => {
    const m = await machine("+61400555034", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin");
    const confirm = await m.next("yes"); // caller ID -> straight to confirm
    expect(confirm.kind).toBe("confirm_booking");
    expect(confirm.say).toMatch(/lock (it|that) in/i);
    expect(confirm.say).not.toMatch(/for four/i); // brief — no full re-read
    const rep = await m.next("can you repeat that?");
    expect(rep.kind).toBe("repeat");
    expect(rep.say).toMatch(/four/i); // on request, the full details
    expect(rep.say).toMatch(/Friday/i);
    expect(rep.say).toMatch(/7 PM/i);
  });

  // When date+time arrive together, the day+date must still be read back (not just
  // the time) so the caller can hear it got the right day (Kevin 2026-10-05).
  it("date+time in one breath still reads the day + date back at the party step", async () => {
    const m = await machine("+61400555033", MORNING); // Monday 2026-10-05
    const t = await m.next("book a table after three weeks on Friday at 6 PM");
    expect(t.kind).toBe("ask_party");
    expect(t.say).toMatch(/Friday/i); // day name
    expect(t.say).toMatch(/October/i); // the date
    expect(t.say).toMatch(/6 PM/i); // and the time
  });

  // A time before opening must STATE the hours, not loop "we're not open then"
  // (live India inbound 2026-10-05: caller tried 3pm/4pm repeatedly, never told when).
  it("a time before opening states the opening hours instead of looping", async () => {
    const m = await machine("+61400555032", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("3 PM"); // before a dinner venue opens
    const t = await m.next("four"); // availability check -> CLOSED
    expect(t.kind).toBe("ask_time");
    expect(t.say).toMatch(/open from|we're open/i); // tells them the window
    expect(t.say).toMatch(/onwards|till/i);
    expect(t.say).not.toMatch(/^We're not open then/);
  });

  // "no, confirm" at the change step must BOOK it, never set the name to "Confirm".
  it("'no, confirm' at the change step books it, never names it 'Confirm'", async () => {
    const m = await machine("+61400555030", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("6 PM");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes"); // caller ID -> confirm_booking
    await m.next("no"); // -> confirm_change ("what would you like to change?")
    const t = await m.next("no, confirm");
    expect(t.kind).toBe("confirmed");
    expect(m.reservation?.customerName).toBe("Kevin");
    expect(m.reservation?.customerName).not.toBe("Confirm");
  });

  // "next Tuesday" on a Monday was booking a week late (Oct 13 instead of Oct 6).
  it("'next Tuesday' books the coming Tuesday, not a week later", async () => {
    const m = await machine("+61400555025", MORNING); // Monday 2026-10-05
    await m.next("book a table");
    await m.next("next Tuesday");
    expect(m.debug().draft.date).toBe("2026-10-06"); // the very next Tuesday
  });

  // "next week on Wednesday" was booking THIS week's Wednesday (Oct 7) instead of
  // the following week (Oct 14).
  it("'next week on Wednesday' in the opener books the following week", async () => {
    const m = await machine("+61400555027", MORNING); // Monday 2026-10-05
    await m.next("book a table for five for next week on Wednesday at 5pm");
    expect(m.debug().draft.date).toBe("2026-10-14"); // coming Wed is Oct 7; next week = Oct 14
  });

  // A bare "the following week" (no weekday) must shift the existing date a week,
  // so a caller never has to fight to move a booking (Kevin 2026-10-05).
  it("'the following week' at the confirm step shifts the date a week", async () => {
    const m = await machine("+61400555029", MORNING); // Monday 2026-10-05
    await m.next("book a table");
    await m.next("this Wednesday"); // Oct 7
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes"); // caller ID -> confirm_booking
    const t = await m.next("actually, the following week");
    expect(m.debug().draft.date).toBe("2026-10-14"); // Oct 7 + 7
    expect(t.kind).toMatch(/confirm/);
  });

  // "in two weeks' time" must move the date out 2 weeks AND not corrupt the time
  // ("about two" was being read as 2 PM).
  it("'in two weeks' time' changes the date by 2 weeks, leaves the time intact", async () => {
    const m = await machine("+61400555028", MORNING); // Monday 2026-10-05
    await m.next("book a table");
    await m.next("this Thursday"); // Oct 8
    await m.next("7 PM"); // 19:00
    await m.next("six");
    await m.next("actually it's not this Thursday, in two weeks' time"); // correct the date
    expect(m.debug().draft.date).toBe("2026-10-22"); // Oct 8 + 2 weeks
    expect(m.debug().draft.time).toBe("19:00"); // time NOT corrupted to 14:00
  });

  // A note added at the confirm step gets a brief ack + lock re-ask — NOT a full
  // re-recitation of the whole booking (which felt like being talked at).
  it("note added at confirm = brief ack, not a full re-read", async () => {
    const m = await machine("+61400555026", MORNING);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes"); // caller ID -> confirm_booking
    const t = await m.next("actually, can we have a window seat?");
    expect(t.kind).toBe("confirm_booking");
    expect(t.say).toMatch(/window/i); // the note was acknowledged
    expect(t.say).toMatch(/lock that in/i); // re-asks the lock question
    expect(t.say).not.toMatch(/table for four/i); // but does NOT re-recite the booking
  });

  // Kevin 2026-10-06: an unhappy caller must be consoled, not ploughed through.
  it("consoles an impatient caller and still lands the booking", async () => {
    const m = await machine("+61400555027", MORNING);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    const c = await m.next("yes"); // caller ID -> confirm beat
    expect(c.kind).toBe("confirm_booking");
    const t = await m.next("ugh this is so slow, yes lock it in");
    // consoled AND booked (not derailed)
    expect(t.say).toMatch(/sorry|won'?t labour|keep this simple/i);
    expect(t.kind).toBe("confirmed");
  });

  it("consoles a strong complaint but still collects what it needs", async () => {
    const m = await machine("+61400555028", MORNING);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four"); // -> ask_name
    const t = await m.next("this is ridiculous, you're being so rude");
    expect(t.say).toMatch(/sorry|frustrat/i); // consoled
    expect(t.kind).toBe("ask_name"); // still needs the name; flow not derailed
  });

  it("does NOT apologise on a normal, happy flow", async () => {
    const m = await machine("+61400555029", MORNING);
    await m.next("book a table");
    await m.next(DATE);
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    const t = await m.next("yes"); // caller ID -> confirm (happy flow, no extra question)
    expect(t.kind).toBe("confirm_booking");
    expect(t.say).not.toMatch(/sorry/i);
  });

  // Kevin 2026-10-07: a caller who's vague about the day ("within two weeks") can't
  // have a specific table reserved (no day) — so take a FIRST NAME and leave a real
  // call-back note, then close. NEVER re-ask the day, and never promise an empty hold.
  it("vague day → takes a name, logs a call-back note, closes (never re-asks the day)", async () => {
    const m = await machine("+61400555030", MORNING);
    await m.next("I'd like to book a table");
    const t = await m.next("sometime within the next two weeks");
    expect(t.kind).toBe("hold_name");               // asks for a name first
    expect(t.say).toMatch(/name/i);
    expect(t.say).not.toMatch(/what day|which day/i);
    expect(t.endCall).toBeFalsy();
    const back = await m.next("Kevin");             // name READ BACK for confirmation
    expect(back.kind).toBe("hold_name");
    expect(back.say).toMatch(/Kevin/);
    expect(back.say).toMatch(/right|spell/i);       // "is that right? …or spell it"
    expect(back.endCall).toBeFalsy();
    const done = await m.next("yes");               // confirmed → note + close
    expect(done.kind).toBe("hold_closed");
    expect(done.endCall).toBe(true);
    expect(done.say).toMatch(/note|ring|lock it in/i);
    expect(done.say).toMatch(/Kevin/);
  });

  // Kevin 2026-10-08: the hold name must be READ BACK so a phone mis-hear
  // ("Joseph" -> "Youssef" on a poor line) is catchable — a correction / spelling wins.
  it("a mis-heard hold name can be corrected before it's logged", async () => {
    const m = await machine("+61400555037", MORNING);
    await m.next("book a table");
    await m.next("after two weeks");
    const ask = await m.next("Youssef");            // heard name → read back
    expect(ask.kind).toBe("hold_name");
    expect(ask.say).toMatch(/Youssef/);
    const sp = await m.next("no");                  // not right → offer to spell
    expect(sp.kind).toBe("hold_name");
    expect(sp.say).toMatch(/spell/i);
    const done = await m.next("J O S E P H");       // spelled → taken as-is, logged
    expect(done.kind).toBe("hold_closed");
    expect(done.say).toMatch(/Joseph/);
  });

  // Kevin 2026-10-07 "if no time fixed also do the same procedure": a caller who's
  // vague about the TIME (day is set) → take a name + call-back note, never loop.
  it("vague TIME → takes a name, logs a call-back note (same as a vague day)", async () => {
    const m = await machine("+61400555035", MORNING);
    await m.next("book a table");
    await m.next("this Saturday");                  // day set
    const t = await m.next("I'm not sure of the time");
    expect(t.kind).toBe("hold_name");
    expect(t.say).toMatch(/name/i);
    await m.next("Kevin");                           // read back
    const done = await m.next("yes");                // confirmed → note + close
    expect(done.kind).toBe("hold_closed");
    expect(done.endCall).toBe(true);
    expect(done.say).toMatch(/time/i);              // note/close references the missing TIME
  });

  it("a decided time given at the hold-name step (vague-time hold) resumes the booking", async () => {
    const m = await machine("+61400555036", MORNING);
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("whenever suits");                 // → hold_name
    const t = await m.next("actually, seven pm");
    expect(t.kind).toBe("ask_party");               // decided a time → booking resumes
  });

  it("a specific far-out day ('two weeks on Thursday') books normally — not held", async () => {
    const m = await machine("+61400555031", MORNING);
    await m.next("book a table");
    const t = await m.next("two weeks on Thursday"); // a real, specific day
    expect(t.kind).toBe("ask_time");                 // proceeds — NOT held
  });

  // If the caller actually decides a day while we're asking for the hold name, resume.
  it("a decided day given at the hold-name step resumes the booking", async () => {
    const m = await machine("+61400555032", MORNING);
    await m.next("book a table");
    await m.next("after two weeks");                 // → hold_name
    const t = await m.next("actually, let's say this Saturday");
    expect(t.kind).toBe("ask_time");                 // decided — booking resumes
  });

  // Live India call 2026-10-07: "after two weeks" re-asked the day five times. It must
  // NEVER re-ask the day — it goes to the name/call-back note instead.
  it("'after two weeks' never re-asks the day", async () => {
    const m = await machine("+61400555033", MORNING);
    await m.next("book a table");
    const t = await m.next("after two weeks");
    expect(t.kind).toBe("hold_name");
    expect(t.say).not.toMatch(/what day|which day|today, tomorrow/i); // never re-asks
  });

  it("a day the parser can't read is re-asked once, then taken as a call-back note (no loop)", async () => {
    const m = await machine("+61400555034", MORNING);
    await m.next("book a table");
    const t1 = await m.next("erm");  // 1st unreadable → one gentle re-ask
    expect(t1.kind).toBe("ask_date");
    expect(t1.endCall).toBeFalsy();
    const t2 = await m.next("mmm"); // 2nd unreadable → name for a call-back note, don't loop
    expect(t2.kind).toBe("hold_name");
    expect(t2.say).not.toMatch(/today, tomorrow/i);
    await m.next("Priya");              // read back
    const done = await m.next("yes");   // confirmed → note + close
    expect(done.kind).toBe("hold_closed");
    expect(done.endCall).toBe(true);
  });

  // India call 2026-10-07: caller asked "is Sunday available?" 5× and was never
  // answered ("I'm not sure"). It must answer from the real hours.
  it("answers 'is Sunday available / a working day?' mid-booking, never deflects", async () => {
    const m = await machine("+61400555060", MORNING);
    await m.next("book a table");
    await m.next("this Sunday");
    const t = await m.next("is Sunday available or a working day?");
    expect(t.kind).toMatch(/info_hours/);
    expect(t.say.toLowerCase()).toMatch(/open/);
    expect(t.say.toLowerCase()).not.toMatch(/not sure/);
  });

  // Live India call 2026-10-07: at the name step the caller asked "May I know the
  // date you've booked?" — the machine mined "May" as the NAME and booked under
  // "May", and ignored the question. It must now READ THE DATE BACK, not name it May.
  it("a read-back question at the name step is answered, never mined as the name", async () => {
    const m = await machine("+61400555065", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("five");
    await m.next("seven");                                  // party 7 → name step
    const t = await m.next("May I know the date you have booked for me?");
    expect(t.kind).toBe("repeat");                          // answered as a read-back
    expect(t.say.toLowerCase()).toMatch(/friday/);          // reads the date back
    expect(m.debug().draft.name).toBeUndefined();           // NOT booked under "May"
  });

  // Live India call 2026-10-07: "four weeks after, on Friday" changed the party to
  // FOUR (caller had said seven). A duration quantity must never be a head count.
  it("'four weeks' in a date correction never changes the party size", async () => {
    const m = await machine("+61400555066", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("five");
    await m.next("seven");                                  // party 7 → name step
    await m.next("actually, four weeks after on Friday");   // date change, NOT party
    expect(m.debug().draft.partySize).toBe(7);              // unchanged
  });

  // Kevin 2026-10-07: "no more looping should be occured". Every slot already bounds
  // its own re-asks; this proves the GLOBAL backstop — a caller who never lets the
  // booking progress is bowed out to a staff call-back within a bounded number of
  // turns, and the call ALWAYS terminates. Never an endless cycle.
  it("global loop-breaker: a caller who never progresses is bowed out, never loops", async () => {
    const m = await machine("+61400555070", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("five");
    await m.next("seven");   // party 7 → name
    await m.next("Kevin");   // name → phone
    await m.next("yes");     // caller ID → confirm beat
    let ended = false;
    let lastKind = "";
    for (let i = 0; i < 20 && !ended; i++) {
      const t = await m.next(i % 2 === 0 ? "no" : "hmm what"); // never a real change
      lastKind = t.kind;
      if (t.endCall || /escalate/.test(t.kind)) ended = true;
    }
    expect(ended, `never terminated; last kind=${lastKind}`).toBe(true);
  });

  // Kevin 2026-10-07: be aware of day/date confusion. Two days offered must be
  // clarified, not silently picked (like party "four or five").
  it("clarifies when two days are offered ('Friday or Saturday'), never guesses", async () => {
    const m = await machine("+61400555063", MORNING); // Mon 5 Oct
    await m.next("book a table");
    const t = await m.next("Friday or Saturday");
    expect(t.kind).toBe("confirm_date");
    expect(t.say).toMatch(/Friday.*Saturday|Saturday.*Friday/);
    const r = await m.next("the first one");
    expect(r.kind).toBe("ask_time");
    expect(m.debug().draft.date).toBe("2026-10-09"); // Friday
  });

  it("a correction in the second option wins ('Friday, actually Saturday')", async () => {
    const m = await machine("+61400555064", MORNING);
    await m.next("book a table");
    const t = await m.next("maybe Friday, actually Saturday");
    expect(t.kind).toBe("ask_time");
    expect(m.debug().draft.date).toBe("2026-10-10"); // Saturday — the correction
  });

  // India call 2026-10-07: caller said "very bad" and got a cheery "Wonderful!". An
  // unhappy caller must get a HUMBLE close, never a chirpy one.
  it("closes humbly (apology) when the caller was unhappy — never 'Wonderful'", async () => {
    const m = await machine("+61400555062", MORNING);
    await m.next("book a table");
    await m.next("this Friday");
    await m.next("7 PM");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes"); // caller ID -> confirm
    await m.next("yes lock it in"); // booked
    const t = await m.next("very bad, thank you"); // unhappy sign-off
    expect(t.endCall).toBe(true);
    expect(t.say.toLowerCase()).toMatch(/sorry|patience|take good care/);
    expect(t.say).not.toMatch(/Wonderful|Brilliant|It's my pleasure/i);
  });

  // India call 2026-10-07: "Susan" said at the spell step was dropped (booked under
  // the number). A name SPOKEN (not spelled) at the spell step must be taken.
  it("takes a name spoken at the spell step ('Susan'), not just spelled letters", async () => {
    const m = await machine("+61400555061", MORNING);
    await m.next("book a table"); await m.next("this Friday"); await m.next("7 PM"); await m.next("four");
    await m.next("um");                 // name fail -> reask
    const s = await m.next("hmm");      // fail -> spell step
    expect(s.kind).toBe("spell_name");
    const rb = await m.next("Susan");   // spoken name at the spell step -> read back
    expect(rb.kind).toBe("confirm_name");
    expect(rb.say).toMatch(/Susan/);
    await m.next("yes");                // confirmed
    expect(m.debug().draft.name).toBe("Susan");
  });
});
