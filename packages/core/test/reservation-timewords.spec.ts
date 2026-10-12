import { describe, expect, it } from "vitest";
import { normaliseTime, normaliseDate } from "../src/domain/reservation-time";

/**
 * TIME & DATE PHRASING BATTERY (Kevin 2026-10-06: "check all the possible saying
 * of day and date even time half past 7 etc — you should not be confused"). Every
 * natural way a caller states a time or a day, asserted to the exact value.
 */

describe("normaliseTime — HOURS-AWARE disambiguation (Kevin 2026-10-10 live call 'half past eleven' looped)", () => {
  // Meat Box opens 17:00 and closes 01:00 → window minutes [1020, 1500).
  const EVENING = { openMin: 1020, closeMin: 1500 };
  it("reads a bare ambiguous hour as the IN-HOURS evening time, not a closed lunchtime", () => {
    expect(normaliseTime("half past eleven", EVENING).time).toBe("23:30"); // was 11:30 AM → looped
    expect(normaliseTime("eleven", EVENING).time).toBe("23:00");
    expect(normaliseTime("twelve", EVENING).time).toBe("00:00");           // midnight, not noon
    expect(normaliseTime("quarter past eleven", EVENING).time).toBe("23:15");
  });
  it("leaves unambiguous and already-evening times alone", () => {
    expect(normaliseTime("seven", EVENING).time).toBe("19:00");
    expect(normaliseTime("half past seven", EVENING).time).toBe("19:30");
    expect(normaliseTime("11 am", EVENING).time).toBe("11:00");            // explicit AM respected
    expect(normaliseTime("7pm", EVENING).time).toBe("19:00");
  });
  it("without a window keeps the original evening-default heuristic (no regression)", () => {
    expect(normaliseTime("half past eleven").time).toBe("11:30");
    expect(normaliseTime("twelve").time).toBe("12:00");
  });
});

describe("normaliseTime — every spoken time form", () => {
  const cases: [string, string][] = [
    // bare + am/pm
    ["seven", "19:00"], ["7", "19:00"], ["7 pm", "19:00"], ["7 p.m.", "19:00"],
    ["7pm", "19:00"], ["8pm", "20:00"], ["7p.m.", "19:00"], ["10am", "10:00"], // glued
    ["5 p.m.", "17:00"], ["seven am", "07:00"], ["10 a.m.", "10:00"],
    ["eight o'clock", "20:00"], ["seven o'clock", "19:00"],
    ["noon", "12:00"], ["midday", "12:00"], ["midnight", "00:00"], ["12", "12:00"],
    // half
    ["half past seven", "19:30"], ["half past 7", "19:30"], ["half seven", "19:30"],
    ["half past six", "18:30"], ["half past twelve", "12:30"],
    ["half past 6 in the evening", "18:30"],
    // quarter
    ["quarter past seven", "19:15"], ["quarter past 7", "19:15"],
    ["quarter to eight", "19:45"], ["quarter to 8", "19:45"],
    ["quarter to one", "12:45"],
    // X past / X to
    ["ten past six", "18:10"], ["twenty past seven", "19:20"],
    ["ten minutes past six", "18:10"], ["ten mins past six", "18:10"], // "N minutes past" (Kevin 2026-10-07)
    ["twenty minutes to eight", "19:40"], ["five minutes past seven", "19:05"],
    ["twenty to eight", "19:40"], ["twenty five to eight", "19:35"],
    ["twenty five past seven", "19:25"], ["five past seven", "19:05"],
    ["ten to seven", "18:50"],
    // "<hour> <minute>" spoken
    ["seven thirty", "19:30"], ["seven fifteen", "19:15"], ["six forty five", "18:45"],
    ["five thirty", "17:30"], ["eight fifteen", "20:15"],
    // digits
    ["7:30", "19:30"], ["7.30", "19:30"], ["19:00", "19:00"], ["6:45", "18:45"],
    ["18:30", "18:30"],
    // with filler
    ["around seven", "19:00"], ["seven tonight", "19:00"], ["about half past seven", "19:30"],
    ["7 in the evening", "19:00"], ["seven in the morning", "07:00"],
    // noon/midnight WITH a relative-minute modifier (audit 2026-10-07: were dropped)
    ["quarter past midday", "12:15"], ["ten past noon", "12:10"], ["quarter to midnight", "23:45"],
    ["half past midday", "12:30"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => {
      expect(normaliseTime(input).time).toBe(expected);
    });
  }
});

describe("normaliseDate — every spoken day/date form (NOW = Thu 1 Oct 2026)", () => {
  const TZ = "Australia/Perth";
  const NOW = new Date("2026-10-01T02:00:00Z"); // Perth Thu 1 Oct 2026, 10:00
  const d = (input: string) => normaliseDate(input, { now: NOW, timezone: TZ, maxAdvanceDays: 400 });
  const cases: [string, string][] = [
    ["today", "2026-10-01"], ["tonight", "2026-10-01"], ["tomorrow", "2026-10-02"],
    ["day after tomorrow", "2026-10-03"],
    ["Friday", "2026-10-02"], ["this Friday", "2026-10-02"], ["next Friday", "2026-10-02"],
    ["Saturday", "2026-10-03"], ["this Saturday", "2026-10-03"], ["coming Saturday", "2026-10-03"],
    ["Sunday", "2026-10-04"], ["Monday", "2026-10-05"], ["Wednesday", "2026-10-07"],
    ["Friday week", "2026-10-09"], ["Tuesday week", "2026-10-13"],
    ["this weekend", "2026-10-03"], ["next weekend", "2026-10-10"],
    ["two weeks on Thursday", "2026-10-15"], ["in two weeks on Thursday", "2026-10-15"],
    ["after three weeks on Wednesday", "2026-10-28"],
    ["a fortnight on Friday", "2026-10-16"],
    ["after a month on Thursday", "2026-10-29"],   // ~4 weeks out on the weekday (Kevin 2026-10-07)
    ["in two months on Thursday", "2026-11-26"],
    ["the 14th", "2026-10-14"], ["14th of October", "2026-10-14"],
    ["October 14", "2026-10-14"], ["October the 14th", "2026-10-14"],
    ["the 15th", "2026-10-15"], ["15th of November", "2026-11-15"],
    ["3/10", "2026-10-03"], ["3-10", "2026-10-03"],
    // weekday + explicit day-of-month: the DATE NUMBER wins, not a bare weekday
    // (audit 2026-10-07: "Wednesday the 14th" silently booked the coming Wednesday).
    // NOW = Thu 1 Oct 2026, so the 14th is a Wednesday (consistent).
    ["Wednesday the 14th", "2026-10-14"], ["Wed the 14th", "2026-10-14"],
    // a digit DURATION must not become the day-of-month (was: day = 2).
    ["in 2 weeks on the 14th", "2026-10-14"], ["in 2 weeks on the 15th", "2026-10-15"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => {
      expect(d(input).date).toBe(expected);
    });
  }

  it("vague forms (no day) return an error so the machine offers to HOLD", () => {
    expect(d("in two weeks").date).toBeUndefined();
    expect(d("after two weeks").date).toBeUndefined();
    expect(d("sometime next week").date).toBeUndefined();
    expect(d("next month").date).toBeUndefined();
  });

  it("DAY 3: definite relative dates resolve; vague ones stay undefined (to clarify)", () => {
    // NOW = Thu 1 Oct 2026.
    expect(d("three weeks from now").date).toBe("2026-10-22");
    expect(d("two weeks later").date).toBe("2026-10-15");
    expect(d("same day next week").date).toBe("2026-10-08");
    expect(d("a week today").date).toBe("2026-10-08");
    expect(d("a week tomorrow").date).toBe("2026-10-09");
    // Vague forms STILL clarify (never silently pick a day) — Kevin 2026-10-09.
    expect(d("in two weeks").date).toBeUndefined();
    expect(d("after two weeks").date).toBeUndefined();
  });

  it("a clock time in the phrase is NEVER scavenged as a day-of-month (live call 2026-10-09)", () => {
    // "after two weeks … 7pm" must NOT become "the 7th" (it booked 7 Nov before).
    expect(d("evening, after two weeks, 7:00 pm").date).toBeUndefined();
    expect(d("after two weeks at 7pm").date).toBeUndefined();
    expect(d("in two weeks 8pm").date).toBeUndefined();
    // With a real weekday, the clock time still doesn't leak — the weekday wins.
    expect(d("Friday at 7pm").date).toBe("2026-10-02");       // NOW = Thu 1 Oct
    expect(d("next Wednesday at 8 pm").date).toBe("2026-10-07");
    // An explicit day-of-month beside a time is kept, the time dropped.
    expect(d("the 14th at 7pm").date).toBe("2026-10-14");
    expect(d("October the 15th at 8 p.m.").date).toBe("2026-10-15");
  });
});

describe("normaliseTime — DAY 3 approximate/colloquial forms", () => {
  const t = (s: string) => normaliseTime(s);
  it("resolves '-ish' forms (hyphen, space, or run-together)", () => {
    expect(t("eightish").time).toBe("20:00");
    expect(t("eight-ish").time).toBe("20:00");
    expect(t("seven ish").time).toBe("19:00");
    expect(t("about eight").time).toBe("20:00");
    expect(t("just before eight").time).toBe("20:00");
  });
  it("NEVER invents a default time for a truly vague phrase (no 12/5/7 PM fallback)", () => {
    expect(t("dinner time").time).toBeUndefined();
    expect(t("around dinner time").time).toBeUndefined();
    expect(t("sometime in the evening").time).toBeUndefined();
  });
});
