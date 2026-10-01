import { describe, expect, it } from "vitest";
import { normaliseDate, normaliseTime } from "../src/domain/reservation-time";

const TZ = "Australia/Perth";
// 2026-10-01 10:00 Perth (UTC+8) — a fixed "now" for deterministic tests.
const NOW = new Date("2026-10-01T02:00:00Z");

function dow(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
}

describe("normaliseDate", () => {
  it("resolves today / tonight", () => {
    expect(normaliseDate("today", { now: NOW, timezone: TZ }).date).toBe("2026-10-01");
    expect(normaliseDate("tonight", { now: NOW, timezone: TZ }).date).toBe("2026-10-01");
  });

  it("resolves tomorrow and day after", () => {
    expect(normaliseDate("tomorrow", { now: NOW, timezone: TZ }).date).toBe("2026-10-02");
    expect(normaliseDate("day after tomorrow", { now: NOW, timezone: TZ }).date).toBe("2026-10-03");
  });

  it("passes ISO dates through", () => {
    expect(normaliseDate("2026-10-15", { now: NOW, timezone: TZ }).date).toBe("2026-10-15");
  });

  it("resolves a bare weekday to the upcoming one", () => {
    const r = normaliseDate("Saturday", { now: NOW, timezone: TZ });
    expect(r.date).toBeTruthy();
    expect(dow(r.date!)).toBe(6);
    // within the next 7 days and not in the past
    expect(r.date! >= "2026-10-01").toBe(true);
    expect(r.date! <= "2026-10-08").toBe(true);
  });

  it("'next Saturday' is a week later than 'Saturday'", () => {
    const thisSat = normaliseDate("this Saturday", { now: NOW, timezone: TZ }).date!;
    const nextSat = normaliseDate("next Saturday", { now: NOW, timezone: TZ }).date!;
    expect(dow(nextSat)).toBe(6);
    expect(nextSat > thisSat).toBe(true);
  });

  it("'Friday week' is the following week's Friday", () => {
    const fri = normaliseDate("Friday", { now: NOW, timezone: TZ }).date!;
    const friWeek = normaliseDate("Friday week", { now: NOW, timezone: TZ }).date!;
    expect(dow(friWeek)).toBe(5);
    expect(friWeek > fri).toBe(true);
  });

  it("resolves 'the 14th' to this month (or next if passed)", () => {
    expect(normaliseDate("the 14th", { now: NOW, timezone: TZ }).date).toBe("2026-10-14");
    // the 1st already 'now' -> today is the 1st, so "the 1st" is today; test a passed day rolls forward
    // (nothing before the 1st this month to test; use a mid-month now would be needed)
  });

  it("resolves '14th of November'", () => {
    expect(normaliseDate("14th of November", { now: NOW, timezone: TZ }).date).toBe("2026-11-14");
  });

  it("rejects past dates", () => {
    expect(normaliseDate("2026-09-30", { now: NOW, timezone: TZ }).error).toBe("PAST");
  });

  it("rejects dates beyond the advance window", () => {
    expect(normaliseDate("2027-06-01", { now: NOW, timezone: TZ, maxAdvanceDays: 120 }).error).toBe("TOO_FAR");
  });

  it("returns INVALID_DATE for nonsense", () => {
    expect(normaliseDate("purple", { now: NOW, timezone: TZ }).error).toBe("INVALID_DATE");
  });
});

describe("normaliseTime dotted am/pm (STT renders 'p.m.')", () => {
  it("parses '5 p.m.' and '5:00 p.m.' as 17:00", () => {
    expect(normaliseTime("5 p.m.").time).toBe("17:00");
    expect(normaliseTime("5:00 p.m.").time).toBe("17:00");
    expect(normaliseTime("at 7 p.m.").time).toBe("19:00");
  });
  it("parses '10 a.m.' as 10:00 (not pushed to PM)", () => {
    expect(normaliseTime("10 a.m.").time).toBe("10:00");
    expect(normaliseTime("9:30 a.m.").time).toBe("09:30");
  });
});

describe("normaliseTime", () => {
  const cases: [string, string][] = [
    ["seven", "19:00"],
    ["7", "19:00"],
    ["around seven", "19:00"],
    ["7 pm", "19:00"],
    ["seven tonight", "19:00"],
    ["7:30", "19:30"],
    ["7.30", "19:30"],
    ["half seven", "19:30"],
    ["quarter past seven", "19:15"],
    ["eight", "20:00"],
    ["seven am", "07:00"],
    ["seven in the morning", "07:00"],
    ["midday", "12:00"],
    ["noon", "12:00"],
    ["midnight", "00:00"],
    ["12", "12:00"],
    ["19:00", "19:00"],
    ["6:45", "18:45"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => {
      expect(normaliseTime(input).time).toBe(expected);
    });
  }

  it("rejects nonsense time", () => {
    expect(normaliseTime("banana").error).toBe("INVALID_TIME");
  });
});
