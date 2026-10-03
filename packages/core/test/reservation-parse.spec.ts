import { describe, expect, it } from "vitest";
import {
  detectInfoQuery,
  detectSeating,
  detectSpecialRequest,
  interpretPartySize,
  numberWord,
  parseName,
  parsePartySize,
  parsePhone,
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
    expect(detectSeating("a booth if possible")).toBe("booth");
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
    expect(detectSpecialRequest("it's a birthday")).toContain("special occasion");
    expect(detectSpecialRequest("we need a high chair")).toContain("high chair");
  });
  it("returns null for normal answers", () => {
    expect(detectSpecialRequest("no special requests")).toBeNull();
    expect(detectSpecialRequest("tomorrow at seven")).toBeNull();
    expect(detectSpecialRequest("Raju")).toBeNull();
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
