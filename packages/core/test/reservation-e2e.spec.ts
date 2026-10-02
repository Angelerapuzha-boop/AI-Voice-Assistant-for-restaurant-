import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext, type ReservationTurn } from "../src/agent/reservation-machine";
import { getReservationSettings, findReservations, createReservation } from "../src/domain/reservations";
import { numberWord } from "../src/agent/reservation-parse";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * The large regression sweep (spec §28, §29). Drives 100+ scripted conversations
 * through the deterministic machine against the real DB and asserts the hard
 * acceptance criteria: no repeated-question loops, no false confirmations, no
 * lost fields, correct party capture, and every confirmed booking backed by a
 * real reservation row.
 */

let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z"); // Perth 10:00 — deterministic

// Always-open hours so availability never depends on the seeded roster.
const OPEN_24_7: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function isoDate(offsetDays: number): string {
  const d = new Date(NOW.getTime() + offsetDays * 86_400_000);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(p.formatToParts(d).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
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

/** No assistant prompt is ever repeated verbatim on the immediately next turn. */
function noConsecutiveRepeat(turns: ReservationTurn[]): boolean {
  for (let i = 1; i < turns.length; i++) {
    if (turns[i]!.say && turns[i]!.say === turns[i - 1]!.say) return false;
  }
  return true;
}

const TIMES = ["seven", "eight", "6 PM", "7:30", "half seven", "8 PM"];
const timeExpect: Record<string, string> = {
  seven: "19:00", eight: "20:00", "6 PM": "18:00", "7:30": "19:30", "half seven": "19:30", "8 PM": "20:00",
};

interface PartyCase {
  expected: number;
  party: string[]; // one or more utterances for the party slot
}

function partyCases(): PartyCase[] {
  const cases: PartyCase[] = [];
  for (let n = 1; n <= 8; n++) {
    const w = numberWord(n);
    cases.push({ expected: n, party: [String(n)] });
    cases.push({ expected: n, party: [w] });
    cases.push({ expected: n, party: [`${w} people`] });
    cases.push({ expected: n, party: [`table for ${w}`] });
    cases.push({ expected: n, party: [`about ${w}`] });
    cases.push({ expected: n, party: [`${n}:00`] }); // STT time-render
    cases.push({ expected: n, party: [`just ${w}`] });
    cases.push({ expected: n, party: [`party of ${w}`] });
    cases.push({ expected: n, party: [`around ${w}`] });
    cases.push({ expected: n, party: [`probably ${w}`] });
    cases.push({ expected: n, party: [`${w} of us`] });
    cases.push({ expected: n, party: [`${w} adults`] });
    cases.push({ expected: n, party: [`for ${w}`] });
  }
  // The specials that used to trap / mis-handle callers.
  cases.push({ expected: 4, party: ["for", "yes"] });            // STT homophone -> confirm
  cases.push({ expected: 5, party: ["four or five", "five"] });  // ambiguity
  cases.push({ expected: 6, party: ["six or seven", "the first"] }); // ambiguity, pick first
  cases.push({ expected: 3, party: ["no, make it three"] });     // correction
  cases.push({ expected: 2, party: ["just the two of us"] });
  cases.push({ expected: 2, party: ["me and my wife"] });
  cases.push({ expected: 1, party: ["just me"] });
  return cases;
}

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
});
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

describe("reservation sweep — 100+ conversations, zero loops / false confirmations (spec §28-29)", () => {
  it("books every party size across many phrasings, each backed by a real row", async () => {
    // Plenty of capacity so availability never interferes with the parse coverage.
    await db.query(`UPDATE reservation_settings SET max_covers_per_slot = 500`);
    settings = await getReservationSettings(db, ctx.restaurant.id);

    const cases = partyCases();
    let confirmations = 0;
    const failures: string[] = [];

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const phone = `+61490${String(100000 + i).slice(-6)}`;
      const date = isoDate(3 + (i % 110));
      const time = TIMES[i % TIMES.length]!;
      const utterances = ["book a table", date, time, ...c.party, "Kevin", "yes please"];
      const m = mk(phone);
      const turns = await run(m, utterances);
      const last = turns[turns.length - 1]!;
      const label = `[${i}] party="${c.party.join(" / ")}" expect ${c.expected}`;

      if (!noConsecutiveRepeat(turns)) { failures.push(`${label}: repeated a question verbatim`); continue; }
      // Confirmed keeps the line open (same-call change/cancel), so it is NOT an
      // endCall turn — assert the confirmation itself, backed by a real row below.
      if (last.kind !== "confirmed") { failures.push(`${label}: did not confirm (kind=${last.kind})`); continue; }
      if (m.reservation?.partySize !== c.expected) { failures.push(`${label}: party ${m.reservation?.partySize} != ${c.expected}`); continue; }
      // §29: a "confirmed" must correspond to a REAL row (no false confirmation).
      const rows = await findReservations(db, ctx.restaurant.id, phone);
      if (rows.length !== 1) { failures.push(`${label}: ${rows.length} rows, expected 1`); continue; }
      if (rows[0]!.partySize !== c.expected) { failures.push(`${label}: db party ${rows[0]!.partySize}`); continue; }
      if (rows[0]!.reservationTime.slice(0, 5) !== timeExpect[time]) {
        failures.push(`${label}: db time ${rows[0]!.reservationTime} != ${timeExpect[time]}`); continue;
      }
      confirmations++;
    }

    expect(failures).toEqual([]);
    expect(confirmations).toBe(cases.length);
    expect(confirmations).toBeGreaterThanOrEqual(100);
  });

  it("unparseable answers fail SAFE (escalate, never confirm, never loop) — no false booking", async () => {
    settings = await getReservationSettings(db, ctx.restaurant.id);
    const scenarios: string[][] = [
      ["book a table", isoDate(5), "seven", "blah", "blah", "blah", "Kevin"],       // party unparseable
      ["book a table", "asdf", "qwer", "zxcv", "Kevin"],                             // date unparseable
      ["book a table", isoDate(7), "mumble", "mumble", "mumble", "Kevin"],           // time unparseable
    ];
    for (let i = 0; i < scenarios.length; i++) {
      const phone = `+61491${String(200000 + i).slice(-6)}`;
      const m = mk(phone);
      const turns = await run(m, scenarios[i]!);
      const last = turns[turns.length - 1]!;
      expect(noConsecutiveRepeat(turns), `scenario ${i} looped`).toBe(true);
      // Ended in a call-back escalation, NOT a confirmed booking.
      expect(["escalated", "escalate_name", "escalate_phone"]).toContain(last.kind);
      expect(m.reservation).toBeNull();
      expect((await findReservations(db, ctx.restaurant.id, phone)).length).toBe(0);
    }
  });

  it("cancel and modify across several bookings stay correct", async () => {
    settings = await getReservationSettings(db, ctx.restaurant.id);
    for (let i = 0; i < 8; i++) {
      const phone = `+61492${String(300000 + i).slice(-6)}`;
      const date = isoDate(10 + i);
      await createReservation(db, {
        restaurantId: ctx.restaurant.id, customerName: "Kevin", customerPhone: phone,
        date, time: "19:00", partySize: 2,
      });
      if (i % 2 === 0) {
        const m = mk(phone);
        await m.next("cancel my booking");
        const t = await m.next("yes");
        expect(t.kind).toBe("cancelled");
        expect((await findReservations(db, ctx.restaurant.id, phone)).length).toBe(0);
      } else {
        const m = mk(phone);
        await m.next("change my booking");
        const t = await m.next("make it 5 people");
        expect(t.kind).toBe("modified");
        const rows = await findReservations(db, ctx.restaurant.id, phone);
        expect(rows[0]!.partySize).toBe(5);
      }
    }
  });
});
