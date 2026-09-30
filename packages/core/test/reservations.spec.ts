import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  cancelReservation,
  checkAvailability,
  createReservation,
  findReservations,
  getReservationByRef,
  getReservationSettings,
  modifyReservation,
} from "../src/domain/reservations";
import { normaliseDate } from "../src/domain/reservation-time";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

let ctx: TestContext;
let db: pg.Pool;
const TZ = "Australia/Perth";
const NOW = new Date();
// A valid future date within the seed hours (17:00–01:00), a few days out.
const DATE = normaliseDate("2026-12-15", { now: NOW, timezone: TZ }).date!; // Tue, well ahead

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetTransactionalData(db);
});

async function settings() {
  return getReservationSettings(db, ctx.restaurant.id);
}
async function avail(date: string, time: string, partySize: number) {
  return checkAvailability({
    db, restaurantId: ctx.restaurant.id, hours: ctx.hours, settings: await settings(),
    timezone: TZ, now: NOW, date, time, partySize,
  });
}

describe("checkAvailability", () => {
  it("AVAILABLE for a normal in-hours booking", async () => {
    expect((await avail(DATE, "19:00", 4)).status).toBe("AVAILABLE");
  });

  it("PARTY_TOO_LARGE beyond max party size", async () => {
    expect((await avail(DATE, "19:00", 11)).status).toBe("PARTY_TOO_LARGE");
  });

  it("CLOSED when outside opening hours (noon, hours are 5pm–1am)", async () => {
    expect((await avail(DATE, "12:00", 2)).status).toBe("CLOSED");
  });

  it("INVALID_DATE for a past date", async () => {
    expect((await avail("2020-01-01", "19:00", 2)).status).toBe("INVALID_DATE");
  });

  it("offers ALTERNATIVES when the exact slot is full but nearby is free", async () => {
    await db.query(
      `UPDATE reservation_settings SET max_covers_per_slot = 4, turnover_minutes = 15`,
    );
    await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "A", customerPhone: "+61400000001",
      date: DATE, time: "19:00", partySize: 4,
    });
    const r = await avail(DATE, "19:00", 2);
    expect(r.status).toBe("ALTERNATIVES_AVAILABLE");
    expect(r.alternatives.length).toBeGreaterThan(0);
    expect(r.alternatives).not.toContain("19:00");
  });

  it("UNAVAILABLE when the slot and all nearby are full", async () => {
    await db.query(`UPDATE reservation_settings SET max_covers_per_slot = 2, turnover_minutes = 90`);
    await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "A", customerPhone: "+61400000002",
      date: DATE, time: "19:00", partySize: 2,
    });
    expect((await avail(DATE, "19:00", 1)).status).toBe("UNAVAILABLE");
  });
});

describe("createReservation", () => {
  it("creates a confirmed booking with a reference", async () => {
    const { reservation, duplicate } = await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "Kevin", customerPhone: "+61400111222",
      date: DATE, time: "19:00", partySize: 4,
    });
    expect(duplicate).toBe(false);
    expect(reservation.status).toBe("CONFIRMED");
    expect(reservation.publicRef).toMatch(/^R\d+$/);
    expect(reservation.partySize).toBe(4);
  });

  it("is idempotent on idempotencyKey (no second row)", async () => {
    const key = "call-abc-1";
    const a = await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "Kevin", customerPhone: "+61400111333",
      date: DATE, time: "19:00", partySize: 4, idempotencyKey: key,
    });
    const b = await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "Kevin", customerPhone: "+61400111333",
      date: DATE, time: "19:00", partySize: 4, idempotencyKey: key,
    });
    expect(b.duplicate).toBe(true);
    expect(b.reservation.id).toBe(a.reservation.id);
  });

  it("dedups an accidental exact-duplicate active booking (no idempotency key)", async () => {
    const base = {
      restaurantId: ctx.restaurant.id, customerName: "Sam", customerPhone: "+61400111444",
      date: DATE, time: "20:00", partySize: 2,
    };
    const a = await createReservation(db, base);
    const b = await createReservation(db, base);
    expect(b.duplicate).toBe(true);
    expect(b.reservation.id).toBe(a.reservation.id);
  });
});

describe("find / modify / cancel", () => {
  async function book(phone: string, time = "19:00", party = 4) {
    return (await createReservation(db, {
      restaurantId: ctx.restaurant.id, customerName: "Kevin", customerPhone: phone,
      date: DATE, time, partySize: party,
    })).reservation;
  }

  it("finds a caller's active reservations", async () => {
    await book("+61400222111");
    const found = await findReservations(db, ctx.restaurant.id, "+61400222111");
    expect(found.length).toBe(1);
    expect(found[0]!.customerPhone).toBe("+61400222111");
  });

  it("finds a reservation by reference", async () => {
    const r = await book("+61400222222");
    const byRef = await getReservationByRef(db, ctx.restaurant.id, r.publicRef.toLowerCase());
    expect(byRef?.id).toBe(r.id);
  });

  it("modifies party size (re-checks availability, updates atomically)", async () => {
    const r = await book("+61400222333", "19:00", 4);
    const result = await modifyReservation(db, {
      reservationId: r.id, changes: { partySize: 6 },
      hours: ctx.hours, settings: await settings(), timezone: TZ, now: NOW,
    });
    expect("reservation" in result).toBe(true);
    if ("reservation" in result) expect(result.reservation.partySize).toBe(6);
  });

  it("cancels a booking (status CANCELLED, no longer found)", async () => {
    const r = await book("+61400222444");
    const cancelled = await cancelReservation(db, r.id);
    expect(cancelled?.status).toBe("CANCELLED");
    expect((await findReservations(db, ctx.restaurant.id, "+61400222444")).length).toBe(0);
  });
});
