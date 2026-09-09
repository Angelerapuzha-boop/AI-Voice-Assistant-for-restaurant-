import { describe, expect, it } from "vitest";
import { openStateAt, validateRequestedTime } from "../src/domain/hours";
import type { RestaurantHoursRow } from "../src/types";

const TZ = "Australia/Perth"; // UTC+8, no DST

function weekly(opens: string, closes: string): RestaurantHoursRow[] {
  return Array.from({ length: 7 }, (_, day) => ({
    id: String(day),
    restaurantId: "r",
    dayOfWeek: day,
    opensAt: opens,
    closesAt: closes,
    isClosed: false,
  }));
}

/** Perth local time -> Date */
function perth(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

describe("openStateAt with overnight hours (5pm–1am, Meatbox's real hours)", () => {
  const rows = weekly("17:00", "01:00");

  it("closed mid-afternoon", () => {
    expect(openStateAt(rows, perth("2026-09-09T14:00:00"), TZ).open).toBe(false);
  });

  it("open in the evening", () => {
    const state = openStateAt(rows, perth("2026-09-09T19:30:00"), TZ);
    expect(state.open).toBe(true);
    expect(state.minutesUntilClose).toBe((24 - 19.5 + 1) * 60);
  });

  it("open after midnight under the previous day's window", () => {
    const state = openStateAt(rows, perth("2026-09-10T00:30:00"), TZ);
    expect(state.open).toBe(true);
    expect(state.minutesUntilClose).toBe(30);
  });

  it("closed at 1:30am", () => {
    expect(openStateAt(rows, perth("2026-09-10T01:30:00"), TZ).open).toBe(false);
  });

  it("respects closed days", () => {
    const withClosedWednesday = rows.map((r) =>
      r.dayOfWeek === 3 ? { ...r, isClosed: true } : r,
    );
    // 2026-09-09 is a Wednesday
    expect(openStateAt(withClosedWednesday, perth("2026-09-09T19:00:00"), TZ).open).toBe(false);
    // but Tuesday's overnight tail still covers Wednesday 00:30
    expect(openStateAt(withClosedWednesday, perth("2026-09-09T00:30:00"), TZ).open).toBe(true);
  });
});

describe("openStateAt with same-day hours", () => {
  const rows = weekly("09:00", "17:00");
  it("boundary behaviour", () => {
    expect(openStateAt(rows, perth("2026-09-09T08:59:00"), TZ).open).toBe(false);
    expect(openStateAt(rows, perth("2026-09-09T09:00:00"), TZ).open).toBe(true);
    expect(openStateAt(rows, perth("2026-09-09T16:59:00"), TZ).open).toBe(true);
    expect(openStateAt(rows, perth("2026-09-09T17:00:00"), TZ).open).toBe(false);
  });
});

describe("validateRequestedTime", () => {
  const rows = weekly("17:00", "01:00");
  const base = {
    rows,
    timezone: TZ,
    now: perth("2026-09-09T18:00:00"),
    minPrepMinutes: 20,
    maxFutureHours: 8,
    futureOrdersEnabled: true,
  };

  it("accepts a valid pickup", () => {
    expect(validateRequestedTime({ ...base, requested: perth("2026-09-09T19:00:00") }).ok).toBe(true);
  });

  it("rejects times in the past", () => {
    expect(validateRequestedTime({ ...base, requested: perth("2026-09-09T17:00:00") }).ok).toBe(false);
  });

  it("enforces minimum prep time", () => {
    const result = validateRequestedTime({ ...base, requested: perth("2026-09-09T18:10:00") });
    expect(result.ok).toBe(false);
  });

  it("enforces the future window", () => {
    const result = validateRequestedTime({ ...base, requested: perth("2026-09-10T18:00:00") });
    expect(result.ok).toBe(false);
  });

  it("rejects pickups when the kitchen is closed", () => {
    const result = validateRequestedTime({
      ...base,
      now: perth("2026-09-09T22:00:00"),
      requested: perth("2026-09-10T02:00:00"), // after 1am close
      maxFutureHours: 8,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts an after-midnight pickup inside the overnight window", () => {
    const result = validateRequestedTime({
      ...base,
      now: perth("2026-09-09T22:00:00"),
      requested: perth("2026-09-10T00:30:00"),
    });
    expect(result.ok).toBe(true);
  });

  it("blocks far-future orders when future orders are disabled", () => {
    const result = validateRequestedTime({
      ...base,
      futureOrdersEnabled: false,
      requested: perth("2026-09-09T21:00:00"),
    });
    expect(result.ok).toBe(false);
  });
});
