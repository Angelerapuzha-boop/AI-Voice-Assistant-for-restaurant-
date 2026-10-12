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

  it("'next <weekday>' is the COMING occurrence, not a week out (Kevin 2026-10-05)", () => {
    // For a restaurant booking "next Tuesday" means the coming Tuesday, same as a
    // bare/"this" weekday. Only "<weekday> week" means the following week.
    const thisSat = normaliseDate("this Saturday", { now: NOW, timezone: TZ }).date!;
    const nextSat = normaliseDate("next Saturday", { now: NOW, timezone: TZ }).date!;
    const bareSat = normaliseDate("Saturday", { now: NOW, timezone: TZ }).date!;
    expect(dow(nextSat)).toBe(6);
    expect(nextSat).toBe(thisSat);
    expect(nextSat).toBe(bareSat);
  });

  it("'Friday week' is the following week's Friday", () => {
    const fri = normaliseDate("Friday", { now: NOW, timezone: TZ }).date!;
    const friWeek = normaliseDate("Friday week", { now: NOW, timezone: TZ }).date!;
    expect(dow(friWeek)).toBe(5);
    expect(friWeek > fri).toBe(true);
  });

  it("'next week on <weekday>' / 'the following <weekday>' = the FOLLOWING week (Kevin 2026-10-05)", () => {
    const thisWed = normaliseDate("Wednesday", { now: NOW, timezone: TZ }).date!;
    const nextWeekWed = normaliseDate("next week on Wednesday", { now: NOW, timezone: TZ }).date!;
    const followingWed = normaliseDate("the following Wednesday", { now: NOW, timezone: TZ }).date!;
    const inFollowingWeek = normaliseDate("the Wednesday in the following week", { now: NOW, timezone: TZ }).date!;
    expect(dow(nextWeekWed)).toBe(3);
    expect(nextWeekWed > thisWed).toBe(true); // a week later than the coming Wednesday
    expect(followingWed).toBe(nextWeekWed);
    expect(inFollowingWeek).toBe(nextWeekWed);
    // ...but a plain "next <weekday>" (no "week") is still the COMING one
    const nextTue = normaliseDate("next Tuesday", { now: NOW, timezone: TZ }).date!;
    const thisTue = normaliseDate("Tuesday", { now: NOW, timezone: TZ }).date!;
    expect(nextTue).toBe(thisTue);
  });

  it("'in N weeks' / 'a fortnight' push the weekday out N weeks (Kevin 2026-10-05)", () => {
    // NOW = Thursday 2026-10-01. "in two weeks on Thursday" = Oct 15 (today + 14).
    const inTwoWeeksThu = normaliseDate("in two weeks on Thursday", { now: NOW, timezone: TZ }).date!;
    const aboutTwoWeeks = normaliseDate("in about two weeks' time on Thursday", { now: NOW, timezone: TZ }).date!;
    expect(dow(inTwoWeeksThu)).toBe(4);
    expect(inTwoWeeksThu).toBe("2026-10-15");
    expect(aboutTwoWeeks).toBe("2026-10-15");
    const fortnightFri = normaliseDate("a fortnight on Friday", { now: NOW, timezone: TZ }).date!;
    expect(dow(fortnightFri)).toBe(5);
    expect(fortnightFri).toBe("2026-10-16"); // coming Fri Oct 2 + 14
  });

  it("weekend + 'after next' phrasings (date battery 2026-10-05)", () => {
    const thisWknd = normaliseDate("this weekend", { now: NOW, timezone: TZ }).date!;
    const nextWknd = normaliseDate("next weekend", { now: NOW, timezone: TZ }).date!;
    expect(dow(thisWknd)).toBe(6); // Saturday
    expect(dow(nextWknd)).toBe(6);
    expect(nextWknd > thisWknd).toBe(true);
    // "the Wednesday after next" = the Wednesday after the coming one
    const comingWed = normaliseDate("Wednesday", { now: NOW, timezone: TZ }).date!;
    const wedAfterNext = normaliseDate("the Wednesday after next", { now: NOW, timezone: TZ }).date!;
    expect(dow(wedAfterNext)).toBe(3);
    expect(wedAfterNext > comingWed).toBe(true);
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

describe("normaliseTime — 'afternoon' must NOT become noon (live bug CA46547d: 7 PM -> 12 PM)", () => {
  it("'7 PM in the afternoon' -> 19:00, never 12:00", () => {
    expect(normaliseTime("7 PM in the afternoon").time).toBe("19:00");
    expect(normaliseTime("at about 7:00 PM in the afternoon for a table of five").time).toBe("19:00");
    expect(normaliseTime("this afternoon at 7").time).toBe("19:00");
  });
  it("midday / noon still resolve to 12:00", () => {
    expect(normaliseTime("midday").time).toBe("12:00");
    expect(normaliseTime("noon").time).toBe("12:00");
    expect(normaliseTime("at noon").time).toBe("12:00");
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

describe("normaliseTime — a DURATION is never a clock time (live calls 2026-10-05/06)", () => {
  it("'two weeks' / 'three days' etc. do NOT parse as 2 PM / 3 o'clock", () => {
    expect(normaliseTime("two weeks").error).toBe("INVALID_TIME");
    expect(normaliseTime("in two weeks").error).toBe("INVALID_TIME");
    expect(normaliseTime("in about two weeks time").error).toBe("INVALID_TIME");
    expect(normaliseTime("three days").error).toBe("INVALID_TIME");
    expect(normaliseTime("a fortnight").error).toBe("INVALID_TIME");
    expect(normaliseTime("four weeks from now").error).toBe("INVALID_TIME");
  });
  it("still reads a real time stated alongside a duration phrase", () => {
    // Caller gives the day as a duration AND an actual clock time in one breath.
    expect(normaliseTime("two weeks on Thursday at 7 pm").time).toBe("19:00");
    expect(normaliseTime("in two weeks at half seven").time).toBe("19:30");
  });
  it("leaves a plain hour untouched (regression guard for the strip)", () => {
    expect(normaliseTime("seven").time).toBe("19:00");
    expect(normaliseTime("9 PM").time).toBe("21:00");
  });
});
