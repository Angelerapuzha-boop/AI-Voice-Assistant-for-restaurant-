import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext, type ReservationTurn } from "../src/agent/reservation-machine";
import { getReservationSettings, findReservations } from "../src/domain/reservations";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * CALL CONSISTENCY (Kevin 2026-10-06: "keep certain consistency in the call, don't
 * make the call fail"). The SAME booking, run many times, must land cleanly EVERY
 * time — same outcome, correct details, and no error/failure state ever reached.
 */
let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z");
const OPEN: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function mk(phone: string): ReservationMachine {
  return new ReservationMachine({
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN,
    settings, timezone: TZ, now: () => NOW, callerPhone: phone,
  });
}
const BAD_KINDS = new Set(["error", "booking_failed", "modify_notfound", "reprompt"]);

beforeAll(async () => { ctx = await setupTestDb(); db = ctx.db; settings = await getReservationSettings(db, ctx.restaurant.id); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

describe("call consistency — never fails, always lands the same", () => {
  it("the identical booking confirms cleanly across 60 runs (varied phrasing engine)", async () => {
    for (let i = 0; i < 60; i++) {
      await resetTransactionalData(db); // each run is a fresh, identical call
      const phone = `+614000${String(10000 + i)}`;
      const m = mk(phone);
      const turns: ReservationTurn[] = [];
      for (const u of ["book a table", "this Saturday", "seven", "four", "Kevin", "yes", "no thanks"]) {
        const t = await m.next(u);
        turns.push(t);
        // never an empty reply, never a template leak, never a hard-error kind mid-call
        expect(t.say.length, `run ${i} empty`).toBeGreaterThan(0);
        expect(t.say, `run ${i} leak`).not.toMatch(/undefined|NaN|\[object|\$\{/);
        expect(BAD_KINDS.has(t.kind), `run ${i} bad kind ${t.kind}: ${t.say}`).toBe(false);
      }
      // the outcome is identical EVERY run: a confirmed booking with the right details
      const last = turns.at(-1)!;
      expect(last.kind, `run ${i} not confirmed`).toBe("confirmed");
      expect(m.reservation?.status, `run ${i}`).toBe("CONFIRMED");
      expect(m.reservation?.partySize).toBe(4);
      expect(m.reservation?.customerName).toBe("Kevin");
      const saved = await findReservations(db, ctx.restaurant.id, phone);
      expect(saved.length, `run ${i} row count`).toBe(1); // exactly one — never zero, never a duplicate
    }
  });

  it("the same caller booking twice (same slot) never double-books", async () => {
    const phone = "+61400088888";
    for (let k = 0; k < 2; k++) {
      const m = mk(phone);
      for (const u of ["book a table", "this Saturday", "seven", "four", "Kevin", "yes", "no thanks"]) {
        await m.next(u);
      }
    }
    const saved = await findReservations(db, ctx.restaurant.id, phone);
    const active = saved.filter((r) => r.status === "CONFIRMED");
    expect(active.length).toBe(1); // idempotent — the second identical booking doesn't duplicate
  });
});
