import { describe, expect, it } from "vitest";
import {
  detectDispleasure,
  detectVagueDate,
  detectVagueTime,
  detectChangeRequest,
  detectInfoQuery,
  detectRepeatRequest,
  detectSeating,
  detectSpecialRequest,
  detectWeekShift,
  interpretPartySize,
  numberWord,
  parseName,
  parsePartySize,
  parsePhone,
  parseSpelledName,
} from "../src/agent/reservation-parse";

/** Resolve an interpretation to a single number for the common assertions:
 * a confident value OR a candidate both mean "the caller means N" (a candidate
 * is confirmed on the call, not rejected). Ambiguous/none return null. */
function resolved(text: string, expectingParty = true): number | null {
  const r = interpretPartySize(text, { expectingParty });
  if (r.kind === "value" || r.kind === "candidate") return r.value;
  return null;
}

describe("interpretPartySize — the 'four people' regression (spec §23)", () => {
  // Every one of these must resolve to 4 when party size is expected.
  const FOUR = [
    "four", "4", "four people", "there are four of us", "we're four",
    "table for four", "just four", "about four", "around four", "probably four",
    "it's four", "four of us", "for four", "party of four", "4 people",
    "yeah four", "four thanks", "Four.", "4:00", "About four.", "we are four",
    "possibly four", "roughly four", "four adults", "four guests",
  ];
  for (const phrase of FOUR) {
    it(`"${phrase}" -> 4`, () => {
      expect(resolved(phrase)).toBe(4);
    });
  }

  it('"4:00 p.m." / "4 p.m." in the party slot -> confident 4 (STT time-suffix is noise)', () => {
    expect(interpretPartySize("4:00 p.m.", { expectingParty: true })).toEqual({ kind: "value", value: 4 });
    expect(interpretPartySize("4 p.m.", { expectingParty: true })).toEqual({ kind: "value", value: 4 });
    expect(interpretPartySize("six p.m.", { expectingParty: true })).toEqual({ kind: "value", value: 6 });
  });

  it('STT homophone "for" -> candidate 4 ONLY while expecting party (spec §2)', () => {
    expect(interpretPartySize("for", { expectingParty: true })).toEqual({ kind: "candidate", value: 4 });
    // Not while NOT expecting party (opener extraction must not guess).
    expect(interpretPartySize("for").kind).toBe("none");
  });

  it('"for dinner" must NOT become party size 4 (spec §2)', () => {
    expect(interpretPartySize("for dinner", { expectingParty: true }).kind).toBe("none");
    expect(interpretPartySize("book me in for dinner", { expectingParty: true }).kind).toBe("none");
  });

  it('"four or five" is ambiguous — never silently picks one (spec §23)', () => {
    const r = interpretPartySize("four or five", { expectingParty: true });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.options).toEqual([4, 5]);
  });

  it('"four to five" and "between four and six" are ambiguous', () => {
    expect(interpretPartySize("four to five", { expectingParty: true }).kind).toBe("ambiguous");
    expect(interpretPartySize("between four and six", { expectingParty: true }).kind).toBe("ambiguous");
  });

  it('"maybe four, actually five" -> 5 (a correction wins, spec §23)', () => {
    const r = interpretPartySize("maybe four, actually five", { expectingParty: true });
    expect(r).toEqual({ kind: "value", value: 5 });
  });

  it('"no, make it six" -> 6', () => {
    expect(resolved("no, make it six")).toBe(6);
  });

  it("just me / me and my wife", () => {
    expect(resolved("just me")).toBe(1);
    expect(resolved("me and my wife")).toBe(2);
    expect(resolved("just the two of us")).toBe(2);
    expect(resolved("a couple")).toBe(2);
  });

  it("gibberish resolves to nothing (so the machine escalates, never loops)", () => {
    expect(interpretPartySize("blah", { expectingParty: true }).kind).toBe("none");
    expect(interpretPartySize("um er hmm", { expectingParty: true }).kind).toBe("none");
    expect(interpretPartySize("for dinner tonight", { expectingParty: true }).kind).toBe("none");
  });
});

describe("interpretPartySize — every party size, digits + words (spec §24)", () => {
  const cases: [string, number][] = [
    ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6],
    ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12],
  ];
  for (const [word, n] of cases) {
    it(`"${word}" and "${n}" -> ${n}`, () => {
      expect(resolved(word)).toBe(n);
      expect(resolved(String(n))).toBe(n);
      expect(resolved(`${word} people`)).toBe(n);
      expect(resolved(`table for ${word}`)).toBe(n);
      // STT time-rendering of the spoken count ("eight" -> "8:00").
      expect(resolved(`${n}:00`)).toBe(n);
    });
  }
});

describe("numberWord", () => {
  it("speaks 0-20 as words, larger as digits", () => {
    expect(numberWord(4)).toBe("four");
    expect(numberWord(12)).toBe("twelve");
    expect(numberWord(25)).toBe("25");
  });
});

describe('"table of N" / "party of N" party phrasing', () => {
  it("resolves table/party/group of N to a party size", () => {
    expect(parsePartySize("a table of five")).toBe(5);
    expect(parsePartySize("for a table of five")).toBe(5);
    expect(parsePartySize("party of 6")).toBe(6);
    expect(parsePartySize("group of eight")).toBe(8);
  });
});

describe("parsePartySize (confident-only wrapper)", () => {
  it("returns a number only for confident values", () => {
    expect(parsePartySize("four")).toBe(4);
    expect(parsePartySize("for")).toBeNull(); // homophone is candidate, not confident
    expect(parsePartySize("four or five")).toBeNull(); // ambiguous
    expect(parsePartySize("blah")).toBeNull();
  });
});

describe("detectInfoQuery", () => {
  it("detects hours enquiries", () => {
    for (const q of ["what are your hours?", "what time do you open", "are you open on Sunday", "opening hours", "how late are you open"]) {
      expect(detectInfoQuery(q), q).toBe("hours");
    }
  });
  it("detects 'is <day> open/available/a working day' questions (India call 2026-10-07)", () => {
    for (const q of [
      "is Sunday available",
      "is Sunday a working day",
      "is Sunday a holiday",
      "is Sunday available or a working day or a holiday",
      "are you open Saturday",
      "do you open on Sunday",
      "is it a holiday",
    ]) {
      expect(detectInfoQuery(q), q).toBe("hours");
    }
  });
  it("detects location enquiries", () => {
    for (const q of ["where are you?", "what's the address", "where are you located", "how do I get there", "whereabouts are you"]) {
      expect(detectInfoQuery(q), q).toBe("location");
    }
  });
  it("does NOT fire on booking phrases or slot answers", () => {
    for (const q of ["book a table for four", "today", "tomorrow at seven", "four people", "Kevin", "0412 345 678", "seven", "yes"]) {
      expect(detectInfoQuery(q), q).toBeNull();
    }
  });
  it("a food order is not an info query (declined elsewhere)", () => {
    expect(detectInfoQuery("can I order a burger")).toBeNull();
  });
});

describe("detectSeating", () => {
  it("detects seating preferences", () => {
    expect(detectSeating("can we sit near the window")).toBe("window seat");
    expect(detectSeating("somewhere outside")).toBe("outdoor seating");
    expect(detectSeating("I want the place which is open air")).toBe("outdoor seating"); // India call 2026-10-05
    expect(detectSeating("i want a open area")).toBe("outdoor seating"); // India call 2026-10-06
    expect(detectSeating("on the terrace")).toBe("outdoor seating");
    expect(detectSeating("a booth if possible")).toBe("booth");
    expect(detectSeating("somewhere quiet please")).toBe("quiet table");
    expect(detectSeating("can we have a secluded spot")).toBe("quiet table");
  });
  it("returns null for normal answers", () => {
    expect(detectSeating("tomorrow")).toBeNull();
    expect(detectSeating("Kevin")).toBeNull();
    expect(detectSeating("four people")).toBeNull();
  });
});

describe("detectSpecialRequest", () => {
  it("captures allergies and dietary + occasion", () => {
    expect(detectSpecialRequest("I'm allergic to shrimp")).toContain("allergy: shrimp");
    expect(detectSpecialRequest("Actually, I'm allergic to prawns.")).toContain("allergy: prawns");
    expect(detectSpecialRequest("we're vegan")).toContain("vegan");
    expect(detectSpecialRequest("it's a birthday")).toContain("birthday");         // specific occasion kept (2026-10-06)
    expect(detectSpecialRequest("it's our anniversary")).toContain("anniversary");
    expect(detectSpecialRequest("it is for party")).toContain("special occasion"); // India call 2026-10-05
    expect(detectSpecialRequest("we're having a get-together")).toContain("special occasion");
    expect(detectSpecialRequest("we need a high chair")).toContain("high chair");
    // NEGATION must never create a false note (live transcript 2026-10-06)
    expect(detectSpecialRequest("no allergies thanks")).toBeNull();
    expect(detectSpecialRequest("no allergies or dietary needs")).toBeNull();
    expect(detectSpecialRequest("not a birthday, just dinner")).toBeNull();
    expect(detectSpecialRequest("no, nothing special")).toBeNull();
    // negation gaps closed (audit 2026-10-07): party / veggie / dietary / equipment
    expect(detectSpecialRequest("we're not having a party")).toBeNull();
    expect(detectSpecialRequest("it's not a birthday party")).toBeNull();
    expect(detectSpecialRequest("we're not veggie, we eat meat")).toBeNull();
    expect(detectSpecialRequest("no high chair, thanks")).toBeNull();
    expect(detectSpecialRequest("we won't need wheelchair access")).toBeNull();
    expect(detectSpecialRequest("no gluten issues for us")).toBeNull();
    // allergy must NOT swallow a following request (India call 2026-10-06)
    expect(detectSpecialRequest("allergic to prawns and i want a open area")).toContain("allergy: prawns");
    expect(detectSpecialRequest("allergic to prawns and i want a open area")).not.toContain("open area");
    // but two allergens in one breath are kept
    expect(detectSpecialRequest("allergic to nuts and dairy")).toContain("allergy: nuts and dairy");
    expect(detectSpecialRequest("we'll have a pram")).toContain("pram space");
    expect(detectSpecialRequest("room for a stroller")).toContain("pram space");
  });
  it("returns null for normal answers", () => {
    expect(detectSpecialRequest("no special requests")).toBeNull();
    expect(detectSpecialRequest("tomorrow at seven")).toBeNull();
    expect(detectSpecialRequest("Raju")).toBeNull();
    // "party of/for N" is the group size, NOT a celebration occasion
    expect(detectSpecialRequest("a party of ten")).toBeNull();
    expect(detectSpecialRequest("party for six")).toBeNull();
  });
});

describe("parseSpelledName", () => {
  it("builds a name from spelled letters", () => {
    expect(parseSpelledName("R A J U")).toBe("Raju");
    expect(parseSpelledName("R-A-J-U")).toBe("Raju");
    expect(parseSpelledName("it's R A J U")).toBe("Raju"); // lead-in ignored
    expect(parseSpelledName("Z, A, P, H, I, R")).toBe("Zaphir");
  });
  it("returns null when it isn't a spelling", () => {
    expect(parseSpelledName("Raju")).toBeNull();
    expect(parseSpelledName("yes that's right")).toBeNull();
    expect(parseSpelledName("")).toBeNull();
  });
  it("DAY 4: handles NATO phonetics, 'X for Y', 'double', and 'capital' (Kevin 2026-10-10)", () => {
    expect(parseSpelledName("W for Whiskey, A, L, Z, A")).toBe("Walza");
    expect(parseSpelledName("B E double L")).toBe("Bell");
    expect(parseSpelledName("capital W, a, l, z, a")).toBe("Walza");
    expect(parseSpelledName("W.A.L.Z.A")).toBe("Walza");
    expect(parseSpelledName("my name is spelled K E V I N")).toBe("Kevin");
    expect(parseSpelledName("alpha lima india")).toBe("Ali"); // NATO standalone
  });
});

describe("detectWeekShift — nudge a date by whole weeks (Kevin 2026-10-05)", () => {
  it("returns a forward shift for 'later'/'following'/'next week'", () => {
    expect(detectWeekShift("the following week")).toBe(7);
    expect(detectWeekShift("a week later")).toBe(7);
    expect(detectWeekShift("next week")).toBe(7);
    expect(detectWeekShift("make it two weeks later")).toBe(14);
    expect(detectWeekShift("a fortnight later")).toBe(14);
  });
  it("returns a backward shift for 'earlier'/'before'", () => {
    expect(detectWeekShift("a week earlier")).toBe(-7);
    expect(detectWeekShift("the week before")).toBe(-7);
    expect(detectWeekShift("two weeks earlier")).toBe(-14);
  });
  it("defers to the absolute path when a weekday is named, or is 0 otherwise", () => {
    expect(detectWeekShift("the following Wednesday")).toBe(0); // weekday -> normaliseDate
    expect(detectWeekShift("next week on Thursday")).toBe(0);
    expect(detectWeekShift("make it six")).toBe(0);
    expect(detectWeekShift("8 PM")).toBe(0);
  });
});

describe("parseName", () => {
  it("extracts names, strips lead-ins", () => {
    expect(parseName("Kevin")).toBe("Kevin");
    expect(parseName("it's Dave")).toBe("Dave");
    expect(parseName("put it under Sarah")).toBe("Sarah");
    expect(parseName("name's John Smith")).toBe("John Smith");
  });
  it("handles polite lead-ins (live call c0b17598 regression)", () => {
    expect(parseName("Can you put it under the name Kevin?")).toBe("Kevin");
    expect(parseName("Uh, can you put it under the name Kevin?")).toBe("Kevin");
    expect(parseName("could you put it down as Dave")).toBe("Dave");
    expect(parseName("the name is Priya")).toBe("Priya");
  });
  it("rejects junk", () => {
    expect(parseName("yes")).toBeNull();
    expect(parseName("um")).toBeNull();
  });
  it("rejects temporal words leaking from an earlier turn (accent sweep L1)", () => {
    expect(parseName("tomorrow")).toBeNull();
    expect(parseName("today")).toBeNull();
    expect(parseName("tonight")).toBeNull();
    // real names that look temporal stay valid
    expect(parseName("June")).toBe("June");
    expect(parseName("May")).toBe("May");
  });
  it("rejects acknowledgements given instead of a name (CHIRP run 3976308)", () => {
    expect(parseName("Oh, that's great. Cheers.")).toBeNull();
    expect(parseName("no worries")).toBeNull();
    expect(parseName("lovely, thanks")).toBeNull();
    expect(parseName("brilliant")).toBeNull();
    expect(parseName("uh-huh")).toBeNull();
    expect(parseName("got")).toBeNull(); // live call: "Raju" mis-STT'd, "Got" booked
    expect(parseName("the time")).toBeNull();
    expect(parseName("the day")).toBeNull();
    // real names still parse, including after a lead-in
    expect(parseName("it's Marcus")).toBe("Marcus");
    expect(parseName("Priya")).toBe("Priya");
  });
  it("live call 2026-10-05: 'fix it <name>' STT artifact and confirm-words", () => {
    // Realtime STT rendered "It's Raju" as "fix it Raju" -> stored "Fix Raju".
    expect(parseName("fix it Raju")).toBe("Raju");
    expect(parseName("yeah fix it raju")).toBe("Raju");
    // "No, it's correct" was stored as the NAME "Correct" — must be rejected so the
    // confirm step treats it as yes/no, not a name.
    expect(parseName("No, it's correct")).toBeNull();
    expect(parseName("that's exactly right")).toBeNull();
    expect(parseName("no that's wrong")).toBeNull();
    // but a genuine fresh name after "no" still parses.
    expect(parseName("No, it's Dave")).toBe("Dave");
    // "confirm" (and the other booking command words) must never become a name
    // (live India call 2026-10-05 booked the name "Confirm" from "no, confirm").
    expect(parseName("no confirm")).toBeNull();
    expect(parseName("confirm")).toBeNull();
    expect(parseName("no, confirm the booking")).toBeNull();
  });
  it("live call 2026-10-05: name bundled with another request in one breath", () => {
    // Was re-asked ("I didn't catch the name") because the window-request words rode
    // along — now the name clause is isolated.
    expect(parseName("can you put it under the name Kevin? And also, I would like to book a table next to the window.")).toBe("Kevin");
    expect(parseName("put me down as Dave and we'd like a quiet table")).toBe("Dave");
    // a request with NO name must still fail — no false name from the request words.
    expect(parseName("I would like a table and a high chair")).toBeNull();
  });
});

describe("parsePhone", () => {
  it("normalises AU mobiles to E.164", () => {
    expect(parsePhone("0412 345 678")).toBe("+61412345678");
    expect(parsePhone("oh four one two three four five six seven eight")).toBe("+61412345678");
    expect(parsePhone("plus six one four one two three four five six seven eight")).toBe("+61412345678");
  });
  it("returns null for too-short input", () => {
    expect(parsePhone("123")).toBeNull();
  });
  it("recovers spoken-digit homophones from accented STT (accent sweep B1/D1/L1)", () => {
    expect(parsePhone("oh four one one, two two two, for for for")).toBe("+61411222444");
    expect(parsePhone("oh four one one, too too too, ate ate ate")).toBe("+61411222888");
    expect(parsePhone("oh four one one, three three three, won won won")).toBe("+61411333111");
  });
  it("homophones do not fabricate a number from ordinary speech", () => {
    expect(parsePhone("I'd like a table for two")).toBeNull();
  });
});

describe("detectDispleasure — console an unhappy caller (Kevin 2026-10-06)", () => {
  it("flags STRONG complaints / anger", () => {
    for (const s of [
      "this is ridiculous",
      "honestly this is a joke",
      "you're being so rude",
      "that's the worst service I've had",
      "I'm absolutely furious",
      "I'm fed up with this",
      "I want to make a complaint",
      "this is a complete waste of my time",
      "very bad",                       // India call 2026-10-07 said this; got "Wonderful!"
      "very bad, thank you",
      "that was terrible",
      "this was a bad experience",
      "the service is awful",
    ]) {
      expect(detectDispleasure(s), s).toBe("strong");
    }
  });
  it("flags MILD impatience / unhappiness", () => {
    for (const s of [
      "I'm not very happy",
      "this is so frustrating",
      "you keep asking me the same thing",
      "I already told you my name",
      "like I said, two weeks",
      "you're not listening to me",
      "this is taking forever",
      "come on, seriously",
      "how many times do I have to say it",
      "that's not good",
      "it could be better",
    ]) {
      expect(detectDispleasure(s), s).toBe("mild");
    }
  });
  it("does NOT trip on neutral replies, corrections or polite declines", () => {
    for (const s of [
      "no thanks",
      "that's all, cheers",
      "no, make it six",
      "actually two weeks on Thursday",
      "yes that's right",
      "the name is Raju",
      "a window seat please",
      "no special occasion",
      "not bad",          // "not bad" = positive, must NOT trip
      "yeah that's good",
    ]) {
      expect(detectDispleasure(s), s).toBeNull();
    }
  });
});

describe("detectVagueDate — caller is non-committal about the day (Kevin 2026-10-06)", () => {
  it("flags a date RANGE with no specific day", () => {
    for (const s of [
      "within two weeks",
      "within the next two weeks",
      "sometime next week",
      "sometime in the next couple of weeks",
      "in the next week or two",
      "a week or so",
      "within a few days",
      "anytime next week",
    ]) {
      expect(detectVagueDate(s), s).toBe(true);
    }
  });
  it("flags a caller who hasn't decided / will decide later", () => {
    for (const s of [
      "I haven't decided the day yet",
      "I'm not sure of the exact day",
      "I'll let you know the day",
      "can I let you know",
      "I'll get back to you",
      "let me think about it",
      "I'm flexible on the day",
      "any day really",
      "whenever suits you",
      "still deciding",
    ]) {
      expect(detectVagueDate(s), s).toBe(true);
    }
  });
  it("does NOT flag a bookable, specific day", () => {
    for (const s of [
      "this Saturday",
      "next Tuesday",
      "two weeks on Thursday",
      "the 14th",
      "tomorrow at seven",
      "Friday week",
    ]) {
      expect(detectVagueDate(s), s).toBe(false);
    }
  });
});

describe("detectChangeRequest (Kevin 2026-10-08: 'change the date' must be honoured)", () => {
  it("names the slot for an explicit change request", () => {
    expect(detectChangeRequest("can you change the date?")).toBe("date");
    expect(detectChangeRequest("change the date to next month the fourteenth")).toBe("date");
    expect(detectChangeRequest("can we change the day")).toBe("date");
    expect(detectChangeRequest("change the time please")).toBe("time");
    expect(detectChangeRequest("change the number of people")).toBe("party");
    expect(detectChangeRequest("can you change the name")).toBe("name");
    expect(detectChangeRequest("move it to a different day")).toBe("date");
  });
  it("returns null when there's no change verb, or a value-less correction, or a decline", () => {
    expect(detectChangeRequest("make it six")).toBeNull();      // in-slot correction path
    expect(detectChangeRequest("Saturday")).toBeNull();
    expect(detectChangeRequest("no changes")).toBeNull();
    expect(detectChangeRequest("don't change anything")).toBeNull();
    expect(detectChangeRequest("yes that's right")).toBeNull();
  });
});

describe("detectVagueTime (Kevin 2026-10-07 'if no time fixed, same procedure')", () => {
  it("true when the caller is undecided about the time", () => {
    for (const s of [
      "not sure of the time",
      "I'm not sure what time yet",
      "haven't decided the time",
      "I did not decide the time",      // live India call 2026-10-07
      "maybe evening",                  // bare time-of-day, no hour
      "in the evening",
      "whenever suits",
      "any time works",
      "I'm flexible",
      "flexible on the time",
      "I'll let you know the time",
      "sometime in the evening",
    ]) {
      expect(detectVagueTime(s), s).toBe(true);
    }
  });
  it("false for a real time or an unrelated reply", () => {
    for (const s of ["seven", "half past six", "7 pm", "around eight", "Kevin", "four people"]) {
      expect(detectVagueTime(s), s).toBe(false);
    }
  });
});

// Live India call 2026-10-07: "four weeks (after, on Friday)" was read as a table
// for FOUR; the QUESTION "May I know the date..." was mined as the name "May"; and
// the caller's "what date did you book?" was ignored. All three fixed below.
describe("duration quantities are never a party size (Kevin 2026-10-07)", () => {
  for (const s of ["four weeks after on Friday", "in four weeks", "about two weeks", "ten minutes past six", "three days later"]) {
    it(`"${s}" → not a party count`, () => {
      expect(interpretPartySize(s, { expectingParty: true }).kind, s).not.toBe("value");
    });
  }
  it("a real party size still parses alongside nothing durational", () => {
    expect(interpretPartySize("four people", { expectingParty: true })).toEqual({ kind: "value", value: 4 });
    const r = interpretPartySize("for four", { expectingParty: true });
    expect(r.kind).toBe("value");
    if (r.kind === "value") expect(r.value).toBe(4);
  });
});

describe("a QUESTION is never mined as the caller's name (Kevin 2026-10-07)", () => {
  for (const q of [
    "May I know the date which you have booked now?",
    "Can I get the date you've booked?",
    "Could you tell me the time?",
    "Will you confirm the booking?",
    "Do you have my booking?",
  ]) {
    it(`"${q}" → null (not a name)`, () => {
      expect(parseName(q), q).toBeNull();
    });
  }
  it("real first names that happen to be modal/month words still parse", () => {
    expect(parseName("May")).toBe("May");
    expect(parseName("it's Will")).toBe("Will");
    expect(parseName("the name's June")).toBe("June");
  });
});

describe("date/day read-back requests are recognised (Kevin 2026-10-07)", () => {
  for (const q of [
    "May I know the date which you have booked now?",
    "May I know which date you have booked for me?",
    "which date have you booked for me?",
    "what date did you book?",
    "can you repeat the date?",
    "can you repeat the date of the day I asked you to book?",
    "can you repeat the, uh, date of day I have asked you to book?", // fillers between
    "tell me the date again",
    "what's the date?",
    // date/month confusion a confused caller voices (rushed past on the live call)
    "is it sixth November or October?",
    "is it the 6th or the 7th?",
    "which month is it?",
    // day-of-week confusion (live India call 2026-10-07, asked twice, unanswered)
    "is it Sunday or Monday?",
    "is the booking for Sunday or Monday?",
    "is the booking is for Sunday or Monday?",
    "which day is it?",
  ]) {
    it(`"${q}" → repeat request`, () => {
      expect(detectRepeatRequest(q), q).toBe(true);
    });
  }
  it("a plain name answer is NOT a repeat request", () => {
    expect(detectRepeatRequest("it's Kevin")).toBe(false);
    expect(detectRepeatRequest("seven o'clock")).toBe(false);
    expect(detectRepeatRequest("four people")).toBe(false);
    expect(detectRepeatRequest("yes that's right")).toBe(false);
  });
  it("a CHANGE command is NOT a read-back (it must change the booking, not restate it)", () => {
    expect(detectRepeatRequest("can you change the day to Sunday or Monday?")).toBe(false);
    expect(detectRepeatRequest("change it to Saturday")).toBe(false);
    expect(detectRepeatRequest("make it Sunday instead")).toBe(false);
  });
});
