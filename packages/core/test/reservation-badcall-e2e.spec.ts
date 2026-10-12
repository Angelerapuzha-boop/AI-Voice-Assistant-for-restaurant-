import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext, type ReservationTurn } from "../src/agent/reservation-machine";
import { getReservationSettings, findReservations } from "../src/domain/reservations";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * BAD-CALL REPRODUCTION (Kevin 2026-10-06 "I don't want any more bad calls — check
 * properly"). Drives the exact things that made real calls feel bad — a vague
 * "within two weeks", the "two weeks"→"2 PM" mangle, repeated name asks, too many
 * preference questions, no consoling an unhappy caller — all the way through the
 * real machine + DB, asserting a clean, sensible outcome with no loops, no garbled
 * acks, and the right booking in the database.
 */

let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z"); // Perth Thu 1 Oct 2026, 10:00 — deterministic

const OPEN_24_7: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function isoDate(offsetDays: number): string {
  const d = new Date(NOW.getTime() + offsetDays * 86_400_000);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(p.formatToParts(d).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dow(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function mk(callerPhone: string | null): ReservationMachine {
  const rc: ReservationContext = {
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN_24_7,
    settings, timezone: TZ, now: () => NOW, callerPhone: callerPhone ?? undefined,
  };
  return new ReservationMachine(rc);
}

async function run(m: ReservationMachine, utterances: string[]): Promise<ReservationTurn[]> {
  const turns: ReservationTurn[] = [];
  for (const u of utterances) turns.push(await m.next(u));
  return turns;
}

/** Hard hygiene every spoken line must pass — no template leaks, no garbled acks,
 * no empty apology/ack, no consecutive verbatim repeat. */
function assertClean(turns: ReservationTurn[]): void {
  for (let i = 0; i < turns.length; i++) {
    const s = turns[i]!.say;
    expect(s, `turn ${i}`).toBeTruthy();
    expect(s, `turn ${i} leak`).not.toMatch(/undefined|null|NaN|\[object|\$\{/);
    // garbled ack like "No worries, I'll 2 PM" / "I'll ." / "I'll  and"
    expect(s, `turn ${i} garbled ack`).not.toMatch(/I'?ll\s+(\d{1,2}\s*(PM|AM|:)|\.|,|and\b|$)/i);
    expect(s, `turn ${i} double space`).not.toMatch(/\s{2,}/);
    if (i > 0 && turns[i - 1]!.say === s) throw new Error(`consecutive repeat at turn ${i}: "${s}"`);
  }
}

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
  settings = await getReservationSettings(db, ctx.restaurant.id);
});
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

describe("bad-call reproduction — the whole thing, end to end", () => {
  it("VAGUE 'within two weeks' → takes a name for a call-back note, never re-asks the day", async () => {
    const phone = "+61400999001";
    const m = mk(phone);
    const turns = await run(m, [
      "hi, I'd like to book a table",
      "sometime within the next two weeks",           // vague → ask name for a call-back note
      "Kevin",                                         // name → read back for confirmation
      "yes",                                           // confirmed → note + close
    ]);
    assertClean(turns);
    expect(turns[1]!.kind).toBe("hold_name");           // NOT a "what day?" loop
    expect(turns[1]!.say).not.toMatch(/what day|which day/i);
    expect(turns[2]!.kind).toBe("hold_name");           // name read back
    expect(turns[3]!.kind).toBe("hold_closed");
    expect(turns[3]!.endCall).toBe(true);
    // Nothing is reserved (no day) — the caller rings back with the exact day.
    expect((await findReservations(db, ctx.restaurant.id, phone)).length).toBe(0);
  });

  it("a caller who names the day up front books cleanly (even a couple of weeks out)", async () => {
    const phone = "+61400999011";
    const m = mk(phone);
    const turns = await run(m, [
      "hi, I'd like to book a table",
      "this Friday",                                  // a real day up front
      "seven",
      "four",
      "Kevin",
      "yes",
      "no thanks",                                    // nothing to add → books straight away
    ]);
    assertClean(turns);
    expect(turns.at(-1)!.kind).toBe("confirmed");
    const saved = await findReservations(db, ctx.restaurant.id, phone);
    expect(saved.length).toBe(1);
    expect(dow(saved[0]!.reservationDate)).toBe(5);      // Friday
    expect(saved[0]!.reservationTime.slice(0, 5)).toBe("19:00");
    expect(saved[0]!.partySize).toBe(4);
    expect(saved[0]!.customerName).toBe("Kevin");
  });

  it("'in two weeks on Thursday' + '7 pm' NEVER becomes 2 PM or 'closed'", async () => {
    const phone = "+61400999002";
    const m = mk(phone);
    const turns = await run(m, [
      "book a table",
      "in two weeks on Thursday",   // date — must NOT read 'two' as 2 o'clock
      "at 7 pm",                    // time
      "four",
      "Priya",                      // uncommon-ish name may read back; that's fine
      "yes that's right",           // confirm name if asked / or caller-ID
      "yes",
      "no thanks",
    ]);
    assertClean(turns);
    // never dumped into the closed-hours path
    for (const t of turns) expect(t.say).not.toMatch(/closed|we're open from/i);
    const saved = await findReservations(db, ctx.restaurant.id, phone);
    expect(saved.length).toBe(1);
    expect(saved[0]!.reservationTime.slice(0, 5)).toBe("19:00");   // 7 PM, NOT 14:00
    expect(dow(saved[0]!.reservationDate)).toBe(4);                 // Thursday
    expect(saved[0]!.reservationDate).toBe(isoDate(14));            // two weeks out
  });

  it("an IMPATIENT caller is consoled and still booked", async () => {
    const m = mk("+61400999003");
    const turns = await run(m, [
      "book a table",
      "this Saturday",
      "eight",
      "four",
      "Kevin",
      "yes",                                                 // caller ID -> confirm beat
      "honestly this is taking forever, just lock it in",    // impatient + confirm
    ]);
    assertClean(turns);
    expect(turns.at(-1)!.say).toMatch(/sorry|won'?t labour|keep this simple/i); // consoled
    expect(turns.at(-1)!.kind).toBe("confirmed");                               // and booked
  });

  it("STRONG complaint mid-call is consoled, flow not derailed, still books", async () => {
    const phone = "+61400999004";
    const m = mk(phone);
    const turns = await run(m, [
      "I want to book a table",
      "tomorrow",
      "seven",
      "four",
      "this is ridiculous, you're being so rude",  // strong complaint at name step
      "Kevin",                                     // gives name after being consoled
      "yes",
      "yes lock it in",
    ]);
    assertClean(turns);
    expect(turns[4]!.say).toMatch(/sorry|frustrat|get this right/i); // consoled
    expect(turns[4]!.kind).toBe("ask_name");                         // still needs the name
    const saved = await findReservations(db, ctx.restaurant.id, phone);
    expect(saved.length).toBe(1);
    expect(saved[0]!.customerName).toBe("Kevin");
  });

  it("undecided caller → call-back note, closed warmly — never loops", async () => {
    const m = mk("+61400999005");
    const turns = await run(m, [
      "book a table",
      "within two weeks",     // vague → ask name for a call-back note
      "Kevin",                // name → read back
      "yes",                  // confirmed → note + close
    ]);
    assertClean(turns);
    expect(turns[1]!.kind).toBe("hold_name");
    expect(turns[1]!.say).not.toMatch(/what day|which day/i); // never re-asks
    expect(turns[3]!.kind).toBe("hold_closed");
    expect(turns[3]!.endCall).toBe(true);
    expect(turns[3]!.say).toMatch(/ring|note|lock it in/i);
  });

  it("a bad line on the NAME is handled gently — warm re-ask, spell offer, then books under the number (never badgers)", async () => {
    const phone = "+61400999007";
    const m = mk(phone);
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    await m.next("four");
    // name can't be caught (STT returns noise that doesn't parse as a name)
    const t1 = await m.next("um");                  // 1st fail → warm re-ask
    expect(t1.kind).toBe("ask_name");
    expect(t1.say).toMatch(/line dipped|whenever you'?re ready/i);
    const t2 = await m.next("hmm");                 // 2nd fail → offer to spell
    expect(t2.kind).toBe("spell_name");
    expect(t2.say).toMatch(/spell/i);
    const t3 = await m.next("uh");                  // spelling fails too → proceed gracefully
    expect(t3.say).toMatch(/under the number|add your name when you arrive/i);
    // never a blunt repeated "what name?" and never dead-ended
    expect(t3.kind).not.toBe("escalated");
    // finish the booking — it goes through under the caller's number
    const c = await m.next("yes");                  // caller ID -> straight to confirm
    expect(c.kind).toBe("confirm_booking");
    expect(c.say).not.toMatch(/\bGuest\b/);         // never addressed as "Guest"
    const done = await m.next("yes lock it in");
    expect(done.kind).toBe("confirmed");
    expect(done.say).not.toMatch(/\bGuest\b/);
    const saved = await findReservations(db, ctx.restaurant.id, phone);
    expect(saved.length).toBe(1);                   // booked despite the bad-line name
  });

  it("a normal happy caller is NOT apologised to and books cleanly", async () => {
    const phone = "+61400999006";
    const m = mk(phone);
    const turns = await run(m, [
      "I'd like to book a table please",
      "this Saturday",
      "seven",
      "four",
      "David",
      "yes",
      "no thanks",
    ]);
    assertClean(turns);
    for (const t of turns) expect(t.say).not.toMatch(/sorry|apolog/i);
    expect(turns.at(-1)!.kind).toBe("confirmed");
    const saved = await findReservations(db, ctx.restaurant.id, phone);
    expect(saved.length).toBe(1);
    expect(saved[0]!.customerName).toBe("David");
  });
});
