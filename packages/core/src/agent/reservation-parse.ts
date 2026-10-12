/**
 * Deterministic slot extraction for the reservation state machine. Interpreting
 * is state-directed: the machine knows which slot it's collecting and parses the
 * answer for THAT slot, which is far more reliable than blind multi-slot parsing.
 * The LLM (voice layer) only helps with messy multi-slot openers.
 *
 * Party size is the highest-risk slot on a phone line — a single number, easy to
 * mishear, and (from the live 8-PM-for-four loop, call 8d55f5f8) the one that
 * trapped a caller in "Sorry, how many people?" five times. So it has a proper
 * three-way interpreter: a CONFIDENT value, an uncertain CANDIDATE to confirm
 * ("Four people?"), or an AMBIGUOUS pair to disambiguate ("four or five?"),
 * never a blind reject that loops.
 */

/** Spoken/typed numbers → integer. No "a"/"an" (too ambiguous as a bare count). */
const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  couple: 2, pair: 2, dozen: 12,
};

/** Number spoken as a word (1-20) for a natural confirmation ("Four people?"). */
export function numberWord(n: number): string {
  const w = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
  ];
  return n >= 0 && n <= 20 ? w[n]! : String(n);
}

const PARTY_MAX = 100;

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9:.\-'\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Intent of a caller utterance. */
export type ReservationIntent =
  | "book"
  | "modify"
  | "cancel"
  | "confirm"
  | "info"
  | "order_food"
  | "unknown";

const FOOD_RE =
  /\b(take\s?away|takeaway|deliver(y|ed)?|uber\s?eats|door\s?dash|menu|order (?:some )?food|food order|order (?:me )?(?:a|an|some|the|two|three)?\s*(?:burger|kebab|meatbox|chips|pizza|wrap|roll|meal|coke|drink|steak|ribeye|rib eye|parmi|parma|schnitzel|schnitty|pasta|salad|entree|main|mains|dessert|wine|beer|side)|(?:can|could) i (?:order|get) (?:a|some|two|the)?\s*(?:burger|kebab|meatbox|chips|pizza|wrap|roll|meal|coke|drink|steak|ribeye|rib eye|parmi|parma|schnitzel|schnitty|pasta|salad|entree|main|mains|dessert|wine|beer|bite|something to eat)|something to eat|two burgers|a burger|hungry)\b/;
const CANCEL_RE = /\b(cancel|scrap|delete|get rid of)\b/;
const MODIFY_RE = /\b(change|modify|move|reschedule|update|push (?:it )?back|bring (?:it )?forward|make it)\b/;
const CONFIRM_EXISTING_RE = /\b(confirm|check|verify|still (?:on|booked)|do i have)\b.*\b(booking|reservation|table)\b/;
const BOOK_RE = /\b(book|reserve|reservation|booking|table|seat|seats|seating|get us in|fit us in|dinner|lunch|dine in|dine-in)\b/;

/** Classify the caller's high-level intent (deterministic first pass). */
export function detectIntent(text: string): ReservationIntent {
  const t = normalise(text);
  if (!t) return "unknown";
  // Food ordering is out of scope — catch it before booking so it's declined.
  if (FOOD_RE.test(t) && !BOOK_RE.test(t)) return "order_food";
  if (CANCEL_RE.test(t)) return "cancel";
  if (CONFIRM_EXISTING_RE.test(t)) return "confirm";
  if (MODIFY_RE.test(t)) return "modify";
  if (BOOK_RE.test(t)) return "book";
  return "unknown";
}

/** True when the caller is trying to order food (used to decline in any state). */
export function isFoodOrderAttempt(text: string): boolean {
  const t = normalise(text);
  return FOOD_RE.test(t) && !BOOK_RE.test(t);
}

// Distinctive multi-word enquiry phrases — chosen so they never collide with a
// date/time/party/name/phone slot answer, so the info layer is safe to check in
// any state (spec: answer general enquiries factually, never invent).
const HOURS_RE =
  /\b(what (?:time|hours)|opening hours|your hours|hours of (?:operation|business)|trading hours|are you open|what time do you (?:open|close|shut)|when do you (?:open|close|shut)|open (?:on|today|tomorrow|now|late|until|till)|what time.*\bopen|how late.*open|is (?:it|that day|the \w+|\w+day|\w+) (?:available|open|a working day|a holiday|a public holiday|closed)|(?:available|open|closed|working) (?:on )?(?:sun|mon|tue|wed|thu|fri|sat|that day|then)|working day|public holiday|is it a holiday|do you (?:open|trade) (?:on )?(?:sun|mon|tue|wed|thu|fri|sat))\b/;
const LOCATION_RE =
  /\b(where are you|where'?s (?:the (?:restaurant|place|venue)|your|it)|what'?s the address|your address|the address|whereabouts|how do i (?:get|find)|how to get (?:there|to you)|located|your location|directions?)\b/;

/** A general enquiry the info layer can answer from real data. null otherwise. */
export function detectInfoQuery(text: string): "hours" | "location" | null {
  const t = normalise(text);
  if (!t) return null;
  // A genuine booking/change/cancel/food request is NOT an info query.
  if (FOOD_RE.test(t)) return null;
  if (LOCATION_RE.test(t)) return "location";
  if (HOURS_RE.test(t)) return "hours";
  return null;
}

// ------------------------------------------------------------- party size

/**
 * Interpretation of a party-size answer.
 * - `value`     — confident count, use it.
 * - `candidate` — uncertain best guess (e.g. STT wrote the homophone "for" for
 *                 "four", or a low-signal single word); CONFIRM it ("Four
 *                 people?") rather than rejecting or guessing (spec §7, §8).
 * - `ambiguous` — two plausible counts ("four or five"); ask which (spec §23).
 * - `none`      — nothing number-like; the machine re-prompts / offers keypad.
 */
export type PartySizeResult =
  | { kind: "value"; value: number }
  | { kind: "candidate"; value: number }
  | { kind: "ambiguous"; options: number[] }
  | { kind: "none" };

// Words that are noise AROUND a number when a count is expected. Stripping them
// lets "about four", "we're four", "it's four", "there are four of us",
// "probably four" all reduce to the bare count. Deliberately excludes "for"/
// "fore" (handled as the "four" homophone) and "or" (handled as ambiguity).
const PARTY_NOISE = new Set([
  "about", "around", "like", "um", "uh", "er", "erm", "hmm", "maybe", "roughly",
  "approximately", "approx", "ish", "just", "only", "probably", "possibly",
  "definitely", "think", "reckon", "say", "guess",
  "people", "person", "persons", "guests", "guest", "pax", "adults", "adult",
  "kids", "heads", "head", "covers", "cover", "seats", "seat", "of", "us",
  "a", "an", "the", "party", "group", "table", "booking", "book",
  "please", "thanks", "thank", "cheers", "yeah", "yep", "yes", "so", "well",
  "and", "it", "its", "that", "thats", "there", "be", "gonna", "we", "were",
  "put", "name", "under", "total", "all", "up", "altogether", "hi", "hello",
  "hey", "i", "m", "re", "s", "ll", "d", "have", "got", "is", "will", "gonna",
  // STT sometimes tacks a time suffix onto a spoken count ("four" -> "4:00 p.m.")
  // in the party slot, where a time is meaningless — treat the suffix as noise so
  // the bare number resolves confidently.
  "p", "pm", "am", "oclock", "clock", "o",
]);

const CORRECTION_RE =
  /\b(actually|make it|change (?:it |that )?to|scrap that|i mean|rather|let'?s say|better (?:make it|do)|no)\b/gi;

/** μ-law/STT can render a spoken count as a clock time ("four" → "4:00"), and
 * add trailing punctuation ("Four."). Fold those to the bare token stream. */
function tokenise(text: string): string[] {
  return normalise(text)
    .replace(/\b(\d{1,2}):00\b/g, "$1")
    .replace(/[.:'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function toInt(w: string): number | null {
  if (/^\d{1,2}$/.test(w)) {
    const n = Number(w);
    return n >= 1 && n <= PARTY_MAX ? n : null;
  }
  const n = WORD_NUM[w];
  return n && n >= 1 && n <= PARTY_MAX ? n : null;
}

function firstNumber(tokens: string[]): number | null {
  for (const w of tokens) {
    const n = toInt(w);
    if (n) return n;
  }
  return null;
}

/** Tens words for compound counts ("twenty five" → 25). */
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Collapse an adjacent tens+unit pair into one number token so a big group reads
 * correctly ("twenty five people" → ["25","people"], not "five"). Lone tens words
 * ("twenty") are left for WORD_NUM. Prevents a too-large party being mis-read as a
 * bookable single digit (curveball survey 2026-10-06: "twenty five" booked 5). */
function collapseCompoundNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tens = TENS[tokens[i]!];
    const unit = i + 1 < tokens.length ? WORD_NUM[tokens[i + 1]!] : undefined;
    if (tens && unit !== undefined && unit >= 1 && unit <= 9) {
      out.push(String(tens + unit));
      i++;
    } else {
      out.push(tokens[i]!);
    }
  }
  return out;
}

/** Duration units — a number before one of these is a DURATION quantity ("four
 * weeks", "ten minutes"), never a party size. Guards against "four weeks (after,
 * on Friday)" being read as a table for four (live India call 2026-10-07 booked 4
 * for 7 off "four weeks"). */
const DURATION_UNITS = new Set([
  "week", "weeks", "day", "days", "month", "months", "year", "years",
  "fortnight", "fortnights", "hour", "hours", "minute", "minutes", "min", "mins",
]);

/** Drop every "<number> <duration-unit>" pair from a token stream so a duration
 * quantity can't be mistaken for a head count. */
function stripDurations(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const nxt = tokens[i + 1];
    if (nxt && DURATION_UNITS.has(nxt.toLowerCase()) && toInt(tokens[i]!) !== null) {
      i++; // skip the unit too — drop both "four" and "weeks"
      continue;
    }
    out.push(tokens[i]!);
  }
  return out;
}

/** "four or five", "four to five", "between four and five" → the two counts. */
function detectRange(tokens: string[]): number[] | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = toInt(tokens[i]!);
    if (!a) continue;
    // a  [or|to|-]  b   (adjacent), or  a  b  with a joiner between handled by
    // the general "between x and y" below.
    const j = tokens[i + 1]!;
    if ((j === "or" || j === "to" || j === "-") && i + 2 < tokens.length) {
      const b = toInt(tokens[i + 2]!);
      if (b && b !== a && Math.abs(b - a) <= 4) return [a, b];
    }
  }
  if (tokens.includes("between") && tokens.includes("and")) {
    const nums = tokens.map(toInt).filter((n): n is number => n !== null);
    if (nums.length >= 2 && nums[0] !== nums[1] && Math.abs(nums[0]! - nums[1]!) <= 6) {
      return [nums[0]!, nums[1]!];
    }
  }
  return null;
}

/**
 * Interpret a party-size answer. `expectingParty` (true while the machine is in
 * the party slot) unlocks the "for" → 4 homophone as a CANDIDATE — context-
 * sensitive so it never fires on "for dinner" or in a general opener (spec §2).
 */
export function interpretPartySize(
  text: string,
  opts: { expectingParty?: boolean } = {},
): PartySizeResult {
  const tokens = stripDurations(collapseCompoundNumbers(tokenise(text)));
  if (tokens.length === 0) return { kind: "none" };
  const t = tokens.join(" ");

  // Explicit "just me" / "me and my wife" phrasings.
  if (/\b(just )?(me|myself) (and|&|n) (my )?(wife|husband|partner|mate|friend|mrs|missus|girlfriend|boyfriend|hubby)\b/.test(t)) {
    return { kind: "value", value: 2 };
  }
  if (/\bjust me\b|\bmyself\b|\bfor one\b|\bone person\b|\bsolo\b|\bon my own\b/.test(t)) {
    return { kind: "value", value: 1 };
  }

  // A correction wins: the number AFTER the last "actually/make it/no…"
  // ("maybe four, actually five" → 5).
  let lastCorr = -1;
  CORRECTION_RE.lastIndex = 0;
  for (let m = CORRECTION_RE.exec(t); m; m = CORRECTION_RE.exec(t)) {
    lastCorr = m.index + m[0].length;
  }
  if (lastCorr >= 0) {
    const after = t.slice(lastCorr).trim().split(" ").filter(Boolean);
    const n = firstNumber(after);
    if (n) return { kind: "value", value: n };
  }

  // Ambiguous "four or five" — never silently pick one (spec §23).
  const range = detectRange(tokens);
  if (range) return { kind: "ambiguous", options: range };

  // Confident phrasings.
  const patterns = [
    /\b(?:party|group|table|booking)\s+(?:of|for)\s+([a-z0-9]+)\b/,
    /\bfor\s+([a-z0-9]+)\b/,
    /\b([a-z0-9]+)\s+(?:people|persons|person|guests|guest|pax|adults|adult|of us|heads|covers|seats)\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = toInt(m[1]!);
      if (n) return { kind: "value", value: n };
    }
  }

  // Reduce to meaningful tokens: drop noise; keep numbers, "for"/"fore".
  const meaningful = tokens.filter((w) => !PARTY_NOISE.has(w) && w !== "or");
  const nums = meaningful.map(toInt).filter((n): n is number => n !== null);
  const forHomophone = meaningful.some((w) => w === "for" || w === "fore");
  const nonNumberWords = meaningful.filter((w) => toInt(w) === null && w !== "for" && w !== "fore");

  // Exactly one count and nothing else contentful → confident.
  if (nums.length === 1 && nonNumberWords.length === 0) return { kind: "value", value: nums[0]! };

  // No number, but "for"/"fore" alone in the party slot → the "four" homophone,
  // offered as a candidate to confirm (spec §2, §7).
  if (opts.expectingParty && nums.length === 0 && forHomophone && nonNumberWords.length === 0) {
    return { kind: "candidate", value: 4 };
  }

  // A lone number buried in filler while we're expecting party ("yeah nah four
  // thanks") → candidate; confirm rather than reject.
  if (opts.expectingParty && nums.length === 1) return { kind: "candidate", value: nums[0]! };

  return { kind: "none" };
}

/**
 * Confident party size only (number | null) — for opener extraction and
 * corrections where guessing is unsafe. Wraps the richer interpreter.
 */
export function parsePartySize(text: string): number | null {
  const r = interpretPartySize(text);
  return r.kind === "value" ? r.value : null;
}

// ------------------------------------------------------------- seating / special requests

/** A seating preference the caller mentions ("near the window", "outside"),
 * captured as a NOTE/request — never a guarantee, and we never invent rooms. */
export function detectSeating(text: string): string | null {
  const t = normalise(text);
  if (/\bwindow\b/.test(t)) return "window seat";
  if (/\b(outside|outdoors?|out door|open[\s-]?air|open[\s-]?area|open[\s-]?space|alfresco|courtyard|patio|garden|terrace|balcony)\b/.test(t)) return "outdoor seating";
  if (/\b(indoors?|inside)\b/.test(t)) return "indoor seating";
  if (/\bbooth\b/.test(t)) return "booth";
  if (/\b(quiet|secluded|away from the noise|somewhere quiet)\b/.test(t)) return "quiet table";
  return null;
}

/** A pure relative week shift of an ALREADY-chosen date — "the following week",
 * "a week later", "two weeks earlier", "make it a week after" — returns the days to
 * add (±7, ±14), or 0. Only fires when NO specific weekday is named (those go through
 * normaliseDate's absolute path). Lets a caller nudge the date by a week without
 * restating the whole thing — Kevin 2026-10-05: "no one has the patience to fight it". */
export function detectWeekShift(text: string): number {
  const t = normalise(text);
  if (/\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/.test(t)) return 0;
  if (!/\bweeks?\b|\bfortnight\b/.test(t)) return 0;
  const two = /\b(two|2|couple of)\s+weeks?\b/.test(t) || /\bfortnight\b/.test(t);
  const n = two ? 14 : 7;
  if (/\b(earlier|before|sooner|bring it forward)\b/.test(t)) return -n;
  return n; // any other week/fortnight mention at a change step = push it out
}

/** Dietary / accessibility / occasion notes to record on the booking. Captured
 * as free-text notes for staff; a food allergy is NOTED, never guaranteed safe. */
export function detectSpecialRequest(text: string): string | null {
  const t = normalise(text);
  const notes: string[] = [];
  // NEGATION guard — "no allergies", "nothing special", "not a birthday" must NEVER
  // create a note (live transcript 2026-10-06 recorded an allergy when the caller
  // said there were NONE). A negation word within a few tokens before the keyword.
  const negated = (kw: string): boolean =>
    new RegExp(`\\b(?:no|not|none|without|don'?t|do ?not|dont|won'?t|will ?not|wont|can'?t|cannot|haven'?t|hasn'?t|isn'?t|aren'?t|nope|nah|zero|nil|nothing)\\b(?:\\s+\\w+){0,3}\\s+${kw}`).test(t) ||
    new RegExp(`\\b${kw}\\w*\\s+(?:free|none|nothing)\\b`).test(t);
  // Capture the allergen(s) but STOP at a new clause — "allergic to prawns AND I
  // want an open area" must give "prawns", not swallow the seating request (live
  // India call 2026-10-06).
  const allergy = t.match(
    /\ballerg(?:ic|y)(?:\s+to)?\s+([a-z][a-z\s]*?)(?=[.,;]|\s+(?:but|also|plus)\b|\s+and\s+(?:i|we|you|they|can|could|please|i'?d|we'?d)\b|\s+(?:i|we)\s+(?:want|need|would|also|just|only)\b|\s+please\b|\s+thanks?\b|$)/,
  );
  if (!negated("allerg")) {
    if (allergy && allergy[1]) {
      const a = allergy[1].trim().replace(/\s+(?:please|thanks?|thank you|that'?s it|that is).*$/, "").trim();
      if (a) notes.push(`allergy: ${a}`);
      else notes.push("allergy noted");
    } else if (/\ballerg/.test(t)) {
      notes.push("allergy noted");
    }
  }
  if (!negated("vegan") && /\bvegan\b/.test(t)) notes.push("vegan");
  // Guard BOTH "vegetarian" and "veggie" — the trigger accepts either, so a negated
  // "veggie" must be caught too (audit 2026-10-07: "we're not veggie" recorded it).
  if (!negated("vegetarian") && !negated("veggie") && /\b(vegetarian|veggie)\b/.test(t)) notes.push("vegetarian");
  // Every dietary / equipment note is negation-guarded so "no high chair", "won't
  // need wheelchair access", "no gluten issues" etc. record nothing (audit 2026-10-07).
  if (!negated("gluten") && !negated("coeliac") && !negated("celiac") && /\b(gluten[\s-]?free|coeliac|celiac)\b/.test(t)) notes.push("gluten-free");
  if (!negated("halal") && /\bhalal\b/.test(t)) notes.push("halal");
  if (!negated("kosher") && /\bkosher\b/.test(t)) notes.push("kosher");
  if (!negated("chair") && /\b(high\s?chair|highchair)\b/.test(t)) notes.push("high chair");
  if (!negated("wheelchair") && !negated("accessible") && !negated("accessibility") && !negated("mobility") && /\b(wheelchair|accessible|accessibility|mobility)\b/.test(t)) notes.push("wheelchair access");
  if (!negated("pram") && !negated("stroller") && !negated("buggy") && !negated("pushchair") && /\b(pram|stroller|buggy|pushchair|pushpram)\b/.test(t)) notes.push("pram space");
  // Occasion — store the SPECIFIC one ("birthday") rather than a generic label, and
  // never when negated ("it's not a birthday").
  const occ = t.match(/\b(birthday|anniversary|engagement|graduation|reunion|farewell|christening|hens?(?:\s+night|\s+do)?|bucks?(?:\s+night|\s+do)?|stag(?:\s+do)?)\b/);
  if (occ && !negated("birthday") && !negated("anniversary") && !negated(occ[1]!.split(/\s/)[0]!)) {
    notes.push(occ[1]!.replace(/\s+(night|do)$/, "").trim());
  } else if (/\b(celebration|celebrating|get[\s-]?together|function)\b/.test(t) && !negated("celebration")) {
    notes.push("special occasion");
  } else if (
    (/\b(?:birthday|dinner|office|house|hens?|bucks?|stag|engagement|farewell|christmas|work|cocktail|dance|graduation)\s+party\b/.test(t) ||
      /\b(?:having|throwing|hosting|it'?s|its|for)\s+a?\s*party\b/.test(t)) &&
    // Guard the "party" branch too — "we're not having a party" / "it's not a
    // birthday party" must record nothing (audit 2026-10-07).
    !negated("party")
  ) {
    notes.push("special occasion");
  }
  return notes.length ? [...new Set(notes)].join("; ") : null;
}

// ------------------------------------------------------------- name / phone

const NON_NAME = new Set([
  "yes", "yeah", "yep", "no", "nah", "nope", "ok", "okay", "sure", "thanks",
  "thank", "please", "um", "uh", "hmm", "hi", "hello", "hey", "mate", "table",
  "booking", "reservation", "name", "the", "for", "under", "its", "it", "a",
  // common non-name fragments left after stripping a request phrase, so e.g.
  // "can we sit near the window" doesn't get accepted as a name.
  "can", "we", "us", "sit", "near", "by", "could", "would", "want", "like",
  "around", "have", "get", "something", "there", "here", "wait", "hang", "hold",
  "actually", "instead", "rather", "scrap", "nevermind", "never",
  // acknowledgements / fillers a caller gives INSTEAD of a name ("oh, that's
  // great, cheers" / "no worries" / "lovely, thanks") — never a name, so re-ask
  // rather than booking the ack as the customer name (CHIRP run 3976308 booked
  // "That's Great Cheers"; also the British "Uh-huh"/"Brilliant" artifacts).
  "oh", "that", "thats", "cheers", "great", "lovely", "perfect", "wonderful",
  "brilliant", "awesome", "excellent", "fantastic", "marvellous", "marvelous",
  "ta", "cool", "righto", "right", "worries", "good", "grand", "nice", "beauty",
  "beaut", "ripper", "yay", "huh", "uhhuh", "uh-huh", "sorry", "alright", "got",
  // affirmations a caller gives when CONFIRMING a read-back ("no, it's correct",
  // "that's exactly right") — never the name itself (live call 2026-10-05 booked
  // the name "Correct"); reject so the confirm step treats it as yes/no, not a name.
  "correct", "exactly", "wrong", "incorrect",
  // booking command / intent words a caller says at the confirm step — never a name
  // (live India call 2026-10-05 booked the name "Confirm" from "no, confirm").
  "confirm", "confirmed", "lock", "book", "booked", "change", "changed", "cancel",
  // the slot words the confirm beat offers ("what would you like to change — the
  // day, the time, or the number?") must never be stored as the NAME.
  "day", "date", "time", "number", "people", "party", "person", "booking",
  // question words — a caller QUESTION is never a name ("why do you need my name"
  // was booked as "Why Do Need"; curveball survey 2026-10-06).
  "why", "what", "when", "where", "who", "whom", "which", "how", "do", "does",
  "did", "need", "whats", "hows", "speak", "talk", "human", "manager", "someone",
]);

/**
 * Extract a customer name from a name-stage answer. Strips lead-ins ("it's Dave",
 * "the name's Dave", "put it under Dave"). Returns null if it isn't a plausible
 * name (so the machine re-asks rather than storing junk).
 */
// Residual non-name words left after lead-in stripping ("can you the Kevin" ->
// "Kevin"). Live call c0b17598: "can you put it under the name Kevin" left
// "can you the Kevin" (4 words) and was rejected — these get filtered out.
const NAME_FILLER = new Set([
  "the", "a", "an", "to", "my", "you", "i", "it", "is", "of", "and", "just",
  "can", "could", "would", "please", "put", "down", "as", "for", "under", "name",
  // STT often renders "It's <name>" as "fix it <name>" on a poor line (live call
  // 2026-10-05: "It's Raju" -> "fix it Raju" -> was stored "Fix Raju"). Filter
  // "fix" so the real name survives.
  "fix", "fixed",
  // leading acknowledgements before a name ("fine, it's Kevin" was booked as "Fine
  // Kevin"; curveball survey 2026-10-06) — strip so only the real name remains.
  "fine", "sure", "yeah", "yep", "ok", "okay", "alright", "right", "cool", "well",
]);

// Temporal words that are never given names — guards against a date/time token
// leaking into the name slot when an earlier utterance overlaps the name step
// (accent sweep L1: "tomorrow" was being stored as the customer's name). Month
// and weekday words are deliberately NOT here — "May", "June", "Sunday" are real
// first names.
const TEMPORAL_NON_NAME = new Set([
  "today", "tonight", "tomorrow", "tomorro", "yesterday", "weekend",
  "morning", "afternoon", "evening", "midday", "noon", "midnight",
]);

// Strong name-introducers — used to pick the right clause when a caller bundles a
// request with the name ("put it under the name Kevin and also a window seat").
const NAME_INTRO_RE = /\b(?:name|under|call me|put me|put it|down as)\b/i;

function extractNameCore(text: string): string | null {
  let t = text.trim().replace(/[.,!?]/g, "");
  t = t.replace(
    /^(?:yeah|yep|yup|nah|no|um|uh|ah|oh|so|well|ok|okay)[,\s]+/i,
    "",
  );
  // Strip polite / lead-in phrases anywhere ("can you put it under the name X",
  // "could you put it down as X", "the name's X", "it's X").
  t = t.replace(
    /\b(?:can you|could you|would you|can i|could i|my name is|the name is|the name'?s|the name|a name|name'?s|name|it'?s|its|it is|this is|i'?m|i am|call me|put it under|put it down|put me down|put it|put me|down as|down|under|as|for)\b/gi,
    " ",
  );
  t = t.replace(/[^a-zA-Z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  let words = t.split(" ").filter(Boolean);
  // Drop any residual connective/filler words, keeping the actual name tokens.
  words = words.filter((w) => !NAME_FILLER.has(w.toLowerCase()));
  if (words.length < 1 || words.length > 3) return null;
  if (words.some((w) => NON_NAME.has(w.toLowerCase()))) return null;
  if (words.some((w) => TEMPORAL_NON_NAME.has(w.toLowerCase()))) return null;
  if (words.every((w) => w.replace(/[^a-z]/gi, "").length <= 1)) return null;
  const joined = words.join(" ");
  if (joined.length < 2 || joined.length > 40) return null;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

export function parseName(text: string): string | null {
  // A QUESTION opener — "May I know…", "Can I get…", "Could you tell…", "Will you
  // confirm…" — is never the caller's name. Without this, "May I know the date you
  // booked?" was mined for the name "May" and the table was booked under "May"
  // (live India call 2026-10-07). EXCEPT when a name-introducer is present, since
  // "Can you put it under the name Kevin?" is a polite name-giving, not a question.
  // A bare first name like "May"/"Will" has no following pronoun, so it isn't caught.
  if (
    /^\s*(?:may|can|could|shall|will|would|do|does|are|is|have|has|did)\s+(?:i|we|you|he|she|they|it)\b/i.test(text) &&
    !NAME_INTRO_RE.test(text)
  ) {
    return null;
  }
  const whole = extractNameCore(text);
  if (whole) return whole;
  // A name given together with another request in one breath ("put it under the
  // name Kevin AND ALSO a table by the window") pollutes the whole-string parse and
  // used to force a second "I didn't catch the name" (live call 2026-10-05). Retry
  // on the clause that actually introduces a name, so the name is caught first time.
  const clauses = text
    .split(/[?.!]+|\b(?:and also|and|also|plus|but)\b|,/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (clauses.length > 1) {
    for (const c of clauses) {
      if (!NAME_INTRO_RE.test(c)) continue;
      const n = extractNameCore(c);
      if (n) return n;
    }
  }
  return null;
}

/** NATO / common phonetic alphabet → first letter, for "W for Whiskey" spelling. */
const PHONETIC: Record<string, string> = {
  alpha: "a", alfa: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f",
  golf: "g", hotel: "h", india: "i", juliet: "j", juliett: "j", kilo: "k", lima: "l",
  mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r", sierra: "s",
  tango: "t", uniform: "u", victor: "v", whiskey: "w", whisky: "w", xray: "x",
  yankee: "y", zulu: "z", apple: "a",
};
const SPELL_FILLER = new Set([
  "the", "letter", "letters", "name", "is", "it", "its", "spelt", "spelled", "spell",
  "spelling", "first", "last", "surname", "thats", "my", "like", "in", "of", "uh", "um",
]);
const SPELL_CASE = new Set(["capital", "caps", "cap", "big", "little", "small", "lower", "lowercase", "upper", "uppercase"]);

/**
 * Build a name from a caller SPELLING it out, or null if the utterance isn't a
 * spelling (so a spoken name → use parseName). Handles "W A L Z A", "W-A-L-Z-A",
 * "W.A.L.Z.A", "it's R.A.J.U", "W for Whiskey, A, L, Z, A", "double L", "capital W",
 * and NATO phonetics. Letters are assembled into ONE name — never separate intents
 * (Kevin 2026-10-10 Day 4). Requires ≥2 isolated letters so ordinary speech returns
 * null. (Spelling fallback when a name is mis-heard — Kevin 2026-10-03.)
 */
export function parseSpelledName(text: string): string | null {
  // "X for/as in/like Y" → keep just the letter X (Y is its expansion, not a letter).
  // Strip apostrophes FIRST so "it's" → "its" (a filler), not a stray "s".
  let t = text.toLowerCase().replace(/['`’]/g, "").replace(/[._-]/g, " ");
  t = t.replace(/\b([a-z])\s+(?:for|as in|as|like)\s+[a-z]+/g, " $1 ");
  t = t.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  const toks = t.split(" ").filter(Boolean);
  let letters = "";
  let isolated = 0;
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!;
    if (w === "double" || w === "triple") {
      const n = toks[i + 1];
      if (n && n.length === 1 && /[a-z]/.test(n)) { letters += n.repeat(w === "double" ? 2 : 3); isolated++; i++; }
      continue;
    }
    if (SPELL_CASE.has(w) || SPELL_FILLER.has(w)) continue;
    if (w.length === 1 && /[a-z]/.test(w)) { letters += w; isolated++; continue; }
    if (PHONETIC[w]) { letters += PHONETIC[w]; isolated++; continue; }
    // A multi-letter, non-phonetic, non-filler word means this isn't a spelling.
  }
  if (letters.length < 2 || isolated < 2 || letters.length > 20) return null;
  return letters[0]!.toUpperCase() + letters.slice(1).toLowerCase();
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", ought: "0", nought: "0",
  one: "1", won: "1",
  two: "2", too: "2", to: "2",
  three: "3", tree: "3",
  four: "4", for: "4", fore: "4",
  five: "5", fife: "5",
  six: "6",
  seven: "7",
  eight: "8", ate: "8",
  nine: "9", niner: "9",
  double: "", triple: "",
};

/**
 * Extract an Australian mobile number from speech. Accepts digit runs and
 * spelled-out digits ("oh four one one..."). Returns E.164 (+61...) when it
 * looks like a valid AU mobile, else null.
 */
export function parsePhone(text: string): string | null {
  const t = text.toLowerCase();
  // Pull explicit digits first.
  let digits = (t.match(/\d/g) ?? []).join("");
  if (digits.length < 7) {
    // Fall back to spelled-out digits with double/triple expansion.
    const tokens = t.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    let out = "";
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i]!;
      if (w === "double" || w === "triple") {
        const next = tokens[i + 1];
        const d = next ? DIGIT_WORDS[next] : undefined;
        if (d) { out += d.repeat(w === "double" ? 2 : 3); i++; }
      } else if (w in DIGIT_WORDS && DIGIT_WORDS[w] !== "") {
        out += DIGIT_WORDS[w];
      }
    }
    if (out.length >= digits.length) digits = out;
  }
  if (!digits) return null;
  // Normalise AU forms: 04xxxxxxxx (10), 4xxxxxxxx (9), 614xxxxxxxx (11).
  if (digits.length === 11 && digits.startsWith("61")) digits = "0" + digits.slice(2);
  if (digits.length === 9 && digits.startsWith("4")) digits = "0" + digits;
  if (digits.length === 10 && digits.startsWith("04")) return "+61" + digits.slice(1);
  // Landlines / other: accept a plausible 10-digit AU number as-is in E.164.
  if (digits.length === 10 && digits.startsWith("0")) return "+61" + digits.slice(1);
  return null;
}

/** A short affirmative ("yes", "yep", "that works", "go on"). */
export function isYes(text: string): boolean {
  const t = normalise(text);
  return /\b(yes|yeah|yep|yup|sure|please|correct|confirm|confirmed|that'?s right|go on|go ahead|sounds good|perfect|lovely|good|ok|okay|do it|book it|lock it in|that works|either|first one|second one|spot on|too right|righto|right)\b/.test(t)
    && !/\bno\b|\bnot\b|\bdon'?t\b|\bnope\b|\bnah\b/.test(t);
}

/** A short negative ("no", "nah", "neither", "that won't work"). */
export function isNo(text: string): boolean {
  const t = normalise(text);
  return /\b(no|nah|nope|neither|won'?t work|doesn'?t work|can'?t do|another|different|something else|not that|not really|nope)\b/.test(t);
}

/** The caller asks us to repeat / read the booking back ("say that again",
 * "what did I book?", "can you run that by me?"). */
/** An explicit request to CHANGE a named slot — "change the date", "change the day
 * to Friday", "move the time", "change the number of people", "different name". Returns
 * which slot, or null when no slot is named (a value-less "make it six" is left to the
 * normal in-slot correction path). Live India call 2026-10-08: "can you change the
 * date?" at the name step was mistaken for a failed name and booked under "Guest". */
export function detectChangeRequest(text: string): "date" | "time" | "party" | "name" | null {
  const t = normalise(text);
  if (!/\b(change|changing|move|switch|amend|swap|different|wrong)\b/.test(t)) return null;
  if (/\b(no|not|don'?t|do not|nothing)\b(?:\s+\w+){0,2}\s+chang/.test(t)) return null; // "no changes" / "don't change"
  if (/\b(date|day)\b/.test(t)) return "date";
  if (/\b(time|o'?clock|hour)\b/.test(t)) return "time";
  if (/\b(people|persons?|party size|group size|number of|guests?|pax|headcount|covers|seats?)\b/.test(t)) return "party";
  if (/\b(name|spelling)\b/.test(t)) return "name";
  return null; // change verb but no slot named — leave to the in-slot correction logic
}

export function detectRepeatRequest(text: string): boolean {
  const t = normalise(text);
  return (
    /\b(say (that|it) again|repeat (that|it)?|come again|one more time|run (that|it) by me|go over (that|it) again|read (that|it|the booking|the details) back|read (that|it) out)\b/.test(t) ||
    // "repeat the date" — tolerate fillers between ("repeat the, uh, date of the day").
    /\brepeat\b[^?.!]*\b(booking|reservation|date|day|time|details)\b/.test(t) ||
    /\bwhat (did|'?d) (i|we) (book|get|say|put)\b/.test(t) ||
    /\bwhat('?s| is| was) (the|my) (booking|reservation|time|date|day|details)\b/.test(t) ||
    // "may I know the date you've booked", "can I get the date", "tell me the date"
    /\b(may|can|could) (i|we) (know|get|hear|have)\b.*\b(date|day|time|booking|reservation|details)\b/.test(t) ||
    /\b(tell|remind) me\b.*\b(date|day|time|booking|reservation)\b/.test(t) ||
    // "which date have you booked (for me)", "what date did you book", "what day is the booking"
    /\b(which|what) (date|day|time)\b.*\b(have you|did you|you'?ve|have i|did i|is it|is the|was the|are we|booked|book|put)\b/.test(t) ||
    // Date/month confusion — "is it sixth November or October?", "which month is it?",
    // "is that the 6th or the 7th?" — a caller checking the booked date (live India
    // call 2026-10-07, asked three times and was rushed past). Read it back.
    /\bwhich (month|date|day)\b/.test(t) ||
    /\b(is it|is that|was it|is the date|is the booking)\b[^?.!]*\bor\b[^?.!]*\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(st|nd|rd|th)?)\b/.test(t) ||
    /\b(is it|is that|was it)\b[^?.!]*\b(january|february|march|april|may|june|july|august|september|october|november|december)\b[^?.!]*\bor\b/.test(t) ||
    // Day-of-week confusion — "is it Sunday or Monday?", "is the booking for Sunday or
    // Monday?" (live India call 2026-10-07, asked twice, unanswered). Anchored on a
    // QUESTION form so a CHANGE command ("change the day to Sunday or Monday") is NOT
    // caught here (that must still change the booking, not read it back).
    /\b(is it|is that|was it|is the (?:booking|reservation|date|day)|(?:booking|reservation) (?:is )?for)\b[^?.!]*\bor\b[^?.!]*\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/.test(t) ||
    /\b(is it|is that|was it)\b[^?.!]*\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b[^?.!]*\bor\b/.test(t) ||
    /\b(sorry,? )?(what was that|didn'?t (catch|hear) that|can you (repeat|say that again))\b/.test(t) ||
    /\b(go over|run through) (the|my) (details|booking|reservation)\b/.test(t)
  );
}

/** The caller is momentarily distracted / talking to someone else / asking us to
 * hold ("hang on", "one sec", "give me a minute", "bear with me"). */
export function detectBusy(text: string): boolean {
  const t = normalise(text);
  return /\b(hang on|hold on|hold up|one sec(ond)?|just a sec(ond)?|just a (minute|moment|mo)|give me a (sec(ond)?|minute|moment|mo)|bear with me|wait a (sec(ond)?|minute|moment)|two secs|gimme a (sec|minute|moment))\b/.test(t);
}

/** The caller signals they're finished ("that's all", "nothing else", "I'm
 * good", "no thanks") — used to end only on a CLEAR done, never on a vague reply. */
export function detectDone(text: string): boolean {
  const t = normalise(text);
  return (
    /\b(that'?s (all|it|everything|the lot|me|fine|great|perfect|lovely)|nothing (else|more|further)|no(thing)? thanks?|i'?m (all )?(good|done|set|right)|we'?re (all )?(good|done|set)|all (good|done|set|sorted)|that(')?ll be all|that will be all|no that'?s (all|it|fine)|nah that'?s (all|it)|cheers,? (thanks|that'?s all)|bye|goodbye|see you|that'?s the lot)\b/.test(t)
  );
}

/** The caller is frustrated, unhappy, or complaining — so the receptionist should
 * slow down, acknowledge it warmly, and make things easy, rather than plough on as
 * if nothing's wrong (Kevin 2026-10-06: "the customer is saying not happy but the
 * ai is so rude and not even consoling"). Returns a strength:
 *   - "strong": an explicit complaint / anger / "this is terrible", "you're rude"
 *   - "mild":   impatience / "you keep asking", "this is taking ages", "I already said"
 *   - null:     no displeasure detected
 * Deliberately narrow so a neutral "no" or a normal correction never trips it. */
export function detectDispleasure(text: string): "strong" | "mild" | null {
  const t = normalise(text);
  // Guard: a plain polite "no thanks / that's all" is NOT displeasure.
  if (detectDone(t) && !/\b(not|n'?t|stop|keep|again|already|ages|forever|rude|ridiculous|terrible|awful|horrible|rubbish|dreadful|worst|bad|poor|useless|hopeless|frustrat|annoy|angry|upset|unhappy|disappoint|complain|waste)\b/.test(t)) {
    return null;
  }
  const strong =
    /\b(this is (ridiculous|terrible|awful|appalling|a joke|a shambles|unacceptable|pathetic|hopeless|useless)|worst (service|experience)|absolutely (terrible|awful|ridiculous|useless)|you'?re (being )?(so )?(rude|useless|hopeless|unhelpful)|so rude|very rude|how rude|this is rubbish|i'?m (so |really |very |absolutely |totally |completely )?(angry|furious|fuming|livid|disgusted)|(absolutely |so )?(furious|fuming|livid)|fed up|had enough|sick of this|never (calling|coming) (back|again)|(?:want to |wish to |like to |need to |going to |gonna )?(?:make|making|lodge|file|register) a complaint|this is a waste of (my )?time|complete waste|(?:very|so|really|pretty|quite|that was|that'?s) (?:bad|terrible|awful|horrible|rubbish|dreadful|poor)|bad experience|poor (?:service|experience)|terrible|awful|horrible|dreadful|appalling|atrocious)\b/;
  if (strong.test(t)) return "strong";
  const mild =
    /\b(not (very )?happy|unhappy|not good enough|not (?:good|great)|no good|could be better|frustrat(ed|ing)|annoy(ed|ing)|disappoint(ed|ing)|upset|this is (so )?(slow|laggy|frustrating|confusing|hard|difficult)|taking (too long|ages|forever)|too (long|slow)|so slow|keep(s)? asking|asking (me )?(the same|again)|(i )?already (told|said|gave)|like i (said|told you)|as i (said|told you)|you'?re not listening|not listening|are you listening|listen to me|for (god'?s|goodness|heaven'?s) sake|come on|seriously|why (is this|do you keep)|how many times)\b/;
  if (mild.test(t)) return "mild";
  return null;
}

/** The caller names a DATE RANGE or is non-committal about the exact day ("within
 * two weeks", "sometime next week", "I haven't decided yet", "I'll let you know")
 * rather than a bookable day. We can't lock a table without a day, so the
 * receptionist offers to hold / pencil it and invites them to confirm the day when
 * ready, instead of looping "what day would you like?" (Kevin 2026-10-06). Only
 * consulted when a specific date did NOT parse, so a precise "in two weeks on
 * Thursday" is unaffected. */
export function detectVagueDate(text: string): boolean {
  const t = normalise(text);
  // A RANGE / "sometime around then" with no specific day: a week/day/fortnight/month
  // unit led by a vague quantity or preposition ("within two weeks", "in the next
  // few days", "sometime next week"), or an explicit "… or so / or two".
  const range =
    (/\b(weeks?|days?|fortnight|months?)\b/.test(t) &&
      /\b(with ?in|in|over|after|some ?time|any ?time|next|coming|a few|few|a couple|couple of|several|around|about)\b/.test(t)) ||
    /\b(weeks?|days?|fortnight)\s+or\s+(?:so|two|three)\b/.test(t);
  // Non-committal: hasn't decided / will decide later / flexible.
  const undecided =
    /\b(not (really |quite |too |yet )?sure (of|about|on|when|yet|what day|which day)|(haven'?t|have not|hasn'?t|didn'?t|did not|don'?t|do not|not) (decided|decide|settled|settle|worked out|work out|figured out|figure out|picked|pick) (a |the )?(day|date)?|still (deciding|working (it|that) out|figuring)|(?:i'?ll |i will |can i |could i |may i )?let you know|i'?ll (decide|work (it|that) out|get back to you|call (you )?back)|(can|could|may) i (get back to you|decide|call (you )?back)|let me (think|decide|check|get back)|decide (later|nearer|closer)|get back to you|not (totally |entirely |completely )?decided|flexible (on|with|about) (the )?(day|date|timing)|i'?m flexible|any day (really|works|is fine|would (do|work))|whenever (suits|works|you'?ve|i)|undecided|tbd|to be (decided|confirmed)|open (to|on) (the )?(day|date|dates))\b/.test(t);
  return range || undecided;
}

/** The caller is vague / undecided about the TIME ("not sure of the time", "whenever
 * suits", "any time", "I'm flexible", "I'll let you know the time", "sometime in the
 * evening"). Like detectVagueDate but for the clock — used to route to a call-back
 * note rather than loop the time question (Kevin 2026-10-07 "if no time fixed also
 * do the same procedure"). Deliberately narrow so a real time still parses. */
export function detectVagueTime(text: string): boolean {
  const t = normalise(text);
  return (
    /\b(not (really |quite |too |yet )?sure (of|about|on|what|which|yet)?\s*(the )?(time|when)|(haven'?t|have not|not|didn'?t|did not|don'?t|do not) (decide|decided|settle|settled|work|worked out|figure|figured out|pick|picked) (the |a )?time|not sure what time|don'?t know (the |what )?time (yet)?|no (particular |set )?time|any ?time(?:'?s| is| works| suits| fine)?|whenever (suits|works|you'?ve|is good|is fine)?|i'?m flexible|flexible (on|with|about) (the )?time|open (to|on) (the )?time|let you know (the )?time|decide (the )?time (later|nearer|closer)|undecided (on|about) (the )?time|to be (decided|confirmed))\b/.test(t) ||
    // A bare time-of-day with no clock hour ("maybe evening", "in the evening",
    // "sometime in the morning"). Only reached after normaliseTime already failed to
    // find an hour, so "7 in the evening" (a real time) never lands here.
    /\b(maybe |just |sometime |around )?(in the |the )?(morning|afternoon|evening|night|arvo)\b/.test(t)
  );
}

/** The caller wants a real human / the manager ("can I speak to someone", "put me
 * through to a person", "is there a manager"). The receptionist can't transfer on
 * this line, so it takes details for a call-back rather than carrying on booking or
 * answering "what day?" (curveball survey 2026-10-06). */
export function detectHumanRequest(text: string): boolean {
  const t = normalise(text);
  return (
    /\b(speak|talk|chat|put me through|transfer|connect me|get me|pass me)\b[^.?]*\b(human|person|someone|somebody|anybody|staff|manager|owner|operator|representative|rep|receptionist|the team|real person|actual person)\b/.test(t) ||
    /\b(want|need|get|give me)\b[^.?]*\b(a |an |the )?(real |actual )?(human|person|manager|operator|someone|somebody)\b/.test(t) ||
    /\b(the|a|your) manager\b/.test(t) ||
    /\b(is|are) (there|you) (a|any|some)?\s?(human|person|someone|manager|staff)\b.*\b(i can (talk|speak)|available|there)\b/.test(t) ||
    /\bhuman being\b/.test(t)
  );
}

/** The caller asks whether they're talking to a bot / a person. Answer honestly
 * and steer back, rather than ignoring it (curveball survey 2026-10-06). */
export function detectBotQuestion(text: string): boolean {
  const t = normalise(text);
  return (
    /\b(are|is) (you|this) (a |an )?(robot|bot|machine|ai|a\.?i\.?|computer|recording|automated|a recording|a machine|a real person|a person|a human|real|human)\b/.test(t) ||
    /\bam i (talking|speaking|chatting) (to|with) (a |an )?(robot|bot|machine|human|person|computer|real person)\b/.test(t) ||
    /\b(you'?re|your) (a |an )?(robot|bot|machine|ai|recording)\b/.test(t) ||
    /\bare you real\b/.test(t)
  );
}

/** A question about something the BOOKING line can't help with (parking, payment,
 * the menu/prices, dress code, wifi, pets, walk-ins). Returns a short topic word
 * for a graceful steer, or null. Deliberately specific so it never swallows a slot
 * answer or a real seating/dietary request. */
export function detectUnsupportedTopic(text: string): string | null {
  const t = normalise(text);
  if (/\b(park|parking|car park|carpark)\b/.test(t)) return "parking";
  if (/\b(pay|payment|card|cash|eftpos|credit card|split the bill|surcharge)\b/.test(t)) return "payment";
  if (/\b(dog|pet|puppy)s?\b/.test(t) && /\b(friendly|allow|allowed|bring|ok|okay|welcome)\b/.test(t)) return "pets";
  if (/\bdress code\b|what (should|do) i wear|smart casual|dress up\b/.test(t)) return "dress code";
  if (/\bwi-?fi|internet\b/.test(t)) return "wifi";
  if (/\bwalk(\s|-)?ins?\b/.test(t)) return "walk-ins";
  if (/\b(how much|how expensive|the price|prices|cost|pricing|how pricey)\b/.test(t)) return "prices";
  return null;
}

