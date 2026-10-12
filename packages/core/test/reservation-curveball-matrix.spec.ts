import { describe, expect, it } from "vitest";
import { normaliseDate, normaliseTime } from "../src/domain/reservation-time";

/**
 * ALL DAY / DATE / TIME CURVEBALLS — one consolidated matrix (Kevin 2026-10-08:
 * "curveball of day date time all should be maintained"). Every way a caller can
 * state a day, a date, or a time — including the tricky combos surfaced on the live
 * calls — asserted to the exact value. A single regression wall for the parsers.
 *
 * NOW = Thursday 1 October 2026 (Australia/Perth) so every relative day is exact.
 */
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z"); // Perth Thu 1 Oct 2026, 10:00
const d = (s: string) => normaliseDate(s, { now: NOW, timezone: TZ, maxAdvanceDays: 400 }).date;
const t = (s: string) => normaliseTime(s).time;

describe("DAY / DATE curveballs — every form resolves to the exact date", () => {
  const cases: [string, string][] = [
    // relative
    ["today", "2026-10-01"], ["tonight", "2026-10-01"], ["tomorrow", "2026-10-02"],
    ["day after tomorrow", "2026-10-03"],
    // weekdays
    ["Friday", "2026-10-02"], ["this Friday", "2026-10-02"], ["next Friday", "2026-10-02"],
    ["Saturday", "2026-10-03"], ["coming Saturday", "2026-10-03"], ["Sunday", "2026-10-04"],
    ["Monday", "2026-10-05"], ["Wednesday", "2026-10-07"],
    ["Friday week", "2026-10-09"], ["Tuesday week", "2026-10-13"],
    // weekends
    ["this weekend", "2026-10-03"], ["next weekend", "2026-10-10"],
    // weeks / months ahead, ON a weekday
    ["next week on Monday", "2026-10-12"],
    ["in two weeks on Thursday", "2026-10-15"],
    ["after three weeks on Wednesday", "2026-10-28"],
    ["a fortnight on Friday", "2026-10-16"],
    ["after a month on Thursday", "2026-10-29"],
    ["in two months on Thursday", "2026-11-26"],
    // day-of-month
    ["the 14th", "2026-10-14"], ["14th of October", "2026-10-14"],
    ["October 14", "2026-10-14"], ["October the 14th", "2026-10-14"],
    ["15th of November", "2026-11-15"],
    // weekday + explicit date number: the NUMBER wins (not a bare weekday)
    ["Wednesday the 14th", "2026-10-14"],
    // a DURATION digit must not become the day-of-month
    ["in 2 weeks on the 14th", "2026-10-14"],
    // numeric (AU day-first)
    ["3/10", "2026-10-03"], ["3-10", "2026-10-03"],
    // "next month (the) Nth" -> that day of the month AFTER this one (Kevin 2026-10-08)
    ["next month the 14th", "2026-11-14"], ["the 14th of next month", "2026-11-14"],
    ["change the date to next month the fourteenth", "2026-11-14"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => expect(d(input), input).toBe(expected));
  }

  it("impossible / past dates do NOT silently resolve", () => {
    expect(d("the 31st of February")).toBeUndefined();
  });

  it("VAGUE day (no specific date) returns no date, so the machine offers a call-back note", () => {
    for (const s of ["in two weeks", "after two weeks", "within two weeks", "sometime next week", "next month", "I'll let you know"]) {
      expect(d(s), s).toBeUndefined();
    }
  });
});

describe("TIME curveballs — every form resolves to the exact 24h time", () => {
  const cases: [string, string][] = [
    // bare + am/pm (evening venue: bare 1-10 -> PM)
    ["seven", "19:00"], ["7", "19:00"], ["6", "18:00"], ["7 pm", "19:00"], ["7 p.m.", "19:00"],
    ["7pm", "19:00"], ["10am", "10:00"], ["seven pm", "19:00"], ["seven am", "07:00"],
    ["eight o'clock", "20:00"], ["seven o'clock", "19:00"],
    // noon / midnight (bare + with an offset)
    ["noon", "12:00"], ["midday", "12:00"], ["midnight", "00:00"], ["12", "12:00"],
    ["quarter past midday", "12:15"], ["ten past noon", "12:10"], ["quarter to midnight", "23:45"],
    // half
    ["half past seven", "19:30"], ["half seven", "19:30"], ["half past 7", "19:30"],
    ["half past six", "18:30"], ["half past twelve", "12:30"],
    // quarter
    ["quarter past seven", "19:15"], ["quarter to eight", "19:45"], ["quarter to one", "12:45"],
    // X past / X to (incl. "N minutes past")
    ["ten past six", "18:10"], ["twenty past seven", "19:20"], ["ten minutes past six", "18:10"],
    ["ten mins past six", "18:10"], ["twenty to eight", "19:40"], ["twenty five to eight", "19:35"],
    ["twenty five past seven", "19:25"], ["five past seven", "19:05"], ["ten to seven", "18:50"],
    // "<hour> <minute>"
    ["seven thirty", "19:30"], ["seven fifteen", "19:15"], ["six forty five", "18:45"], ["five thirty", "17:30"],
    // digits
    ["7:30", "19:30"], ["7.30", "19:30"], ["19:00", "19:00"], ["6:45", "18:45"], ["18:30", "18:30"],
    // filler
    ["around seven", "19:00"], ["about half past seven", "19:30"], ["7 in the evening", "19:00"],
    ["seven in the morning", "07:00"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => expect(t(input), input).toBe(expected));
  }

  it("a DURATION is never read as a clock time ('in two weeks' is not 2 PM)", () => {
    expect(t("in two weeks")).not.toBe("14:00");
    expect(t("after three weeks")).not.toBe("15:00");
  });
});
