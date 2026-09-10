import { describe, expect, it } from "vitest";
import { estimateReadyAt, speakEta } from "../src/domain/eta";

const NOW = new Date("2026-09-10T19:00:00+08:00");

function base(overrides: Partial<Parameters<typeof estimateReadyAt>[0]> = {}) {
  return estimateReadyAt({
    active: [],
    capacity: 2,
    simpleBaselineSeconds: 600,
    complexBaselineSeconds: 1200,
    minPrepMinutes: 0,
    lineCount: 1,
    quantityTotal: 1,
    now: NOW,
    ...overrides,
  });
}

function minutesFromNow(date: Date): number {
  return Math.round((date.getTime() - NOW.getTime()) / 60000);
}

describe("lane-based ready estimate", () => {
  it("empty kitchen: simple order = simple baseline (rounded up to 5 min)", () => {
    expect(minutesFromNow(base())).toBe(10);
  });

  it("large orders use the complex baseline (3+ lines or 4+ items)", () => {
    expect(minutesFromNow(base({ lineCount: 3 }))).toBe(20);
    expect(minutesFromNow(base({ quantityTotal: 4 }))).toBe(20);
  });

  it("required spec scenario: parallel lanes, never a naive sum", () => {
    // Two lanes busy for 8 and 5 minutes; a queued order needing 12 min
    // occupies the 5-min lane until minute 17; the new 10-min order takes
    // the 8-min lane and finishes at minute 18 - NOT minute 35.
    const ready = base({
      active: [
        { estimatedReadyAt: new Date(NOW.getTime() + 8 * 60000), confirmedAt: new Date(1) },
        { estimatedReadyAt: new Date(NOW.getTime() + 5 * 60000), confirmedAt: new Date(2) },
        { estimatedReadyAt: new Date(NOW.getTime() + 17 * 60000), confirmedAt: new Date(3) },
      ],
      capacity: 2,
      simpleBaselineSeconds: 600, // new order needs 10 minutes
    });
    expect(minutesFromNow(ready)).toBe(20); // 18 rounded up to the 5-min mark
    expect(minutesFromNow(ready)).toBeLessThan(35);
  });

  it("respects the minimum prep floor", () => {
    expect(minutesFromNow(base({ minPrepMinutes: 25 }))).toBeGreaterThanOrEqual(25);
  });

  it("overdue active orders never produce a past estimate", () => {
    const ready = base({
      active: [{ estimatedReadyAt: new Date(NOW.getTime() - 10 * 60000), confirmedAt: new Date(1) }],
      capacity: 1,
    });
    expect(ready.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("speaks estimates with 'about'", () => {
    expect(speakEta(new Date(NOW.getTime() + 15 * 60000), NOW)).toBe("about 15 minutes");
  });
});
