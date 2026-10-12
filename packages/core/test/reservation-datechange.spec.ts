import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext, type ReservationTurn } from "../src/agent/reservation-machine";
import { getReservationSettings } from "../src/domain/reservations";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * SUDDEN DATE / DAY CHANGE — respect it at EVERY stage, and PROVE it adds no lag
 * (Kevin 2026-10-06: "even sudden date day change respect the customer give time
 * doesn't mean so much lag?"). A change is applied + acknowledged out loud, and the
 * per-turn brain time is measured so we can show the handling itself is instant
 * (the only "time given" is the endpoint silence, which is the transport layer).
 */

let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z"); // Perth Thu 1 Oct 2026, 10:00
const OPEN_24_7: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function mk(phone: string | null = "+61400222333"): ReservationMachine {
  const rc: ReservationContext = {
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN_24_7,
    settings, timezone: TZ, now: () => NOW, callerPhone: phone ?? undefined,
  };
  return new ReservationMachine(rc);
}
function dow(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}
async function timed(label: string, fn: () => Promise<ReservationTurn>): Promise<{ turn: ReservationTurn; ms: number }> {
  const t0 = performance.now();
  const turn = await fn();
  const ms = performance.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`[datechange] ${label.padEnd(26)} ${ms.toFixed(1)}ms  (${turn.kind}) ${turn.say}`);
  return { turn, ms };
}

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
  settings = await getReservationSettings(db, ctx.restaurant.id);
});
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

describe("sudden date/day change is respected at every stage — with no lag", () => {
  const SAT = 6, SUN = 0, TUE = 2, WED = 3, FRI = 5;
  const lat: number[] = [];

  it("at the TIME step", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("Friday");                       // date = Fri
    const { turn, ms } = await timed("time-step → Saturday", () => m.next("actually can we do Saturday instead"));
    lat.push(ms);
    expect(dow(m.debug().draft.date!)).toBe(SAT); // respected
    expect(turn.say).toMatch(/Saturday/);         // acknowledged out loud
  });

  it("at the PARTY step", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("Friday");
    await m.next("seven");                         // now at party
    const { turn, ms } = await timed("party-step → Sunday", () => m.next("sorry, make it Sunday"));
    lat.push(ms);
    expect(dow(m.debug().draft.date!)).toBe(SUN);
    expect(turn.say).toMatch(/Sunday/);
  });

  it("at the NAME step", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("Friday");
    await m.next("seven");
    await m.next("four");                          // now at name
    const { turn, ms } = await timed("name-step → next Tuesday", () => m.next("actually let's do next Tuesday"));
    lat.push(ms);
    expect(dow(m.debug().draft.date!)).toBe(TUE);
    expect(turn.say).toMatch(/Tuesday/);
  });

  it("at the CONFIRM step", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("Friday");
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes");                           // caller ID -> confirm beat
    const { turn, ms } = await timed("confirm-step → Wednesday", () => m.next("actually, move it to Wednesday"));
    lat.push(ms);
    expect(dow(m.debug().draft.date!)).toBe(WED);
    expect(turn.say).toMatch(/Wednesday/);
  });

  it("AFTER it's booked (POST_CONFIRM)", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("Friday");
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes");
    await m.next("yes lock it in");                // booked
    const before = m.reservation!.reservationDate;
    const { turn, ms } = await timed("post-confirm → Sunday", () => m.next("can we change it to Sunday instead"));
    lat.push(ms);
    expect(m.reservation!.reservationDate).not.toBe(before);
    expect(dow(m.reservation!.reservationDate)).toBe(SUN);
    expect(turn.say).toMatch(/Sunday/);
  });

  it("a change at the confirm beat is rectified (time), stays on the booking", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("Friday");
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes");                          // caller ID -> confirm beat
    const { turn, ms } = await timed("confirm → 8pm", () => m.next("actually, can we make it 8pm"));
    lat.push(ms);
    expect(m.debug().draft.time).toBe("20:00");   // rectified
    expect(turn.say).toMatch(/8 PM|change/i);     // acked
    expect(turn.kind).toMatch(/ask_extras|confirm_booking/); // flowed back
  });

  it("the week-shift shortcut ('the following week') also lands, no re-ask", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("Friday");                        // coming Friday = Oct 2
    await m.next("seven");
    await m.next("four");
    await m.next("Kevin");
    await m.next("yes");
    const { turn } = await timed("confirm-step → +1 week", () => m.next("actually make it the following week"));
    expect(dow(m.debug().draft.date!)).toBe(FRI); // still a Friday…
    expect(m.debug().draft.date).toBe("2026-10-09"); // …but a week later
    expect(turn.say).toMatch(/9th of October|next/i);
  });

  it("every change turn is effectively instant (no lag added by respecting it)", () => {
    const max = Math.max(...lat);
    // eslint-disable-next-line no-console
    console.log(`[datechange] max change-turn brain time = ${max.toFixed(1)}ms over ${lat.length} changes`);
    expect(max).toBeLessThan(150); // brain + a local availability re-check — imperceptible vs the 900ms endpoint
  });
});
