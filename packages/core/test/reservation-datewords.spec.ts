import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext } from "../src/agent/reservation-machine";
import { getReservationSettings } from "../src/domain/reservations";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * DAY/DATE CURVEBALLS (Kevin 2026-10-06): "after 3 weeks on Wed/Fri" must book the
 * EXACT date; "after two weeks" with NO day/date must NOT confuse the caller — it
 * offers to HOLD the booking until they ring back to reserve.
 */
let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z"); // Thu 1 Oct 2026, 10:00 Perth
const OPEN: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function mk(): ReservationMachine {
  return new ReservationMachine({
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN,
    settings, timezone: TZ, now: () => NOW, callerPhone: "+61455500001",
  });
}
function dow(iso: string): number { return new Date(`${iso}T12:00:00Z`).getUTCDay(); }
function daysOut(iso: string): number {
  return Math.round((new Date(`${iso}T12:00:00Z`).getTime() - new Date("2026-10-01T12:00:00Z").getTime()) / 86_400_000);
}

beforeAll(async () => { ctx = await setupTestDb(); db = ctx.db; settings = await getReservationSettings(db, ctx.restaurant.id); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

describe("day/date curveballs — specific N-weeks-on-weekday", () => {
  it("'after three weeks on Wednesday' books that exact Wednesday (~21 days out)", async () => {
    const m = mk();
    await m.next("book a table");
    const t = await m.next("after three weeks on Wednesday");
    expect(t.kind).toBe("ask_time");
    const d = m.debug().draft.date!;
    expect(dow(d)).toBe(3);               // Wednesday
    expect(daysOut(d)).toBeGreaterThanOrEqual(21);
  });

  it("'after two weeks on Friday' books that exact Friday (~14 days out)", async () => {
    const m = mk();
    await m.next("book a table");
    const t = await m.next("after two weeks on Friday");
    expect(t.kind).toBe("ask_time");
    const d = m.debug().draft.date!;
    expect(dow(d)).toBe(5);               // Friday
    expect(daysOut(d)).toBeGreaterThanOrEqual(14);
  });

  it("'in 3 weeks on Friday at 7' captures date AND time together", async () => {
    const m = mk();
    await m.next("book a table");
    const t = await m.next("in 3 weeks on Friday at 7");
    expect(t.kind).toBe("ask_party");     // both captured → straight to party
    expect(dow(m.debug().draft.date!)).toBe(5);
    expect(m.debug().draft.time).toBe("19:00");
  });
});

describe("day/date curveballs — vague (no day) → HOLD until they ring back", () => {
  const vague = [
    "after two weeks",
    "in three weeks",
    "in a fortnight",
    "next month sometime",
    "sometime in the next couple of weeks",
    "within two weeks",
  ];
  for (const phrase of vague) {
    it(`'${phrase}' → takes a name for a call-back note, then closes (no reask loop)`, async () => {
      const m = mk();
      await m.next("book a table");
      const t = await m.next(phrase);
      expect(t.kind, phrase).toBe("hold_name");        // asks for a name first
      expect(t.say, phrase).toMatch(/name/i);
      expect(t.say, phrase).not.toMatch(/what day|which day/i); // never re-asks the day
      await m.next("Kevin");                           // name read back for confirmation
      const done = await m.next("yes");                // confirmed → call-back note + close
      expect(done.kind, phrase).toBe("hold_closed");
      expect(done.endCall, phrase).toBe(true);
      expect(done.say, phrase).toMatch(/ring|note|lock it in/i);
    });
  }

  it("a specific day is NOT held — it books normally even if it's a couple of weeks out", async () => {
    const m = mk();
    await m.next("book a table");
    const t = await m.next("two weeks on Friday");  // specific day, far out
    expect(t.kind).toBe("ask_time");
    expect(dow(m.debug().draft.date!)).toBe(5);
  });
});
