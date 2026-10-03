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
  twenty: 20, couple: 2, pair: 2, dozen: 12,
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
  /\b(take\s?away|takeaway|deliver(y|ed)?|uber\s?eats|door\s?dash|menu|order (?:some )?food|food order|(?:can|could) i (?:order|get) (?:a|some|two|the)?\s*(?:burger|kebab|meatbox|chips|pizza|wrap|roll|meal|coke|drink)|two burgers|a burger|hungry)\b/;
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
  /\b(what (?:time|hours)|opening hours|your hours|hours of (?:operation|business)|trading hours|are you open|what time do you (?:open|close|shut)|when do you (?:open|close|shut)|open (?:on|today|tomorrow|now|late|until|till)|what time.*\bopen|how late.*open)\b/;
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
  const tokens = tokenise(text);
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
  if (/\b(outside|outdoor|out door|alfresco|courtyard|patio|garden)\b/.test(t)) return "outdoor seating";
  if (/\b(indoors?|inside)\b/.test(t)) return "indoor seating";
  if (/\bbooth\b/.test(t)) return "booth";
  if (/\b(quiet|secluded|away from the noise|somewhere quiet)\b/.test(t)) return "quiet table";
  return null;
}

/** Dietary / accessibility / occasion notes to record on the booking. Captured
 * as free-text notes for staff; a food allergy is NOTED, never guaranteed safe. */
export function detectSpecialRequest(text: string): string | null {
  const t = normalise(text);
  const notes: string[] = [];
  const allergy = t.match(/\ballerg(?:ic|y)(?:\s+to)?\s+([a-z][a-z\s]+)/);
  if (allergy && allergy[1]) {
    const a = allergy[1].trim().replace(/\s+(?:please|thanks?|thank you|that'?s it|that is).*$/, "").trim();
    notes.push(a ? `allergy: ${a}` : "allergy (confirm details with caller)");
  } else if (/\ballerg/.test(t)) {
    notes.push("allergy (confirm details with caller)");
  }
  if (/\bvegan\b/.test(t)) notes.push("vegan");
  if (/\b(vegetarian|veggie)\b/.test(t)) notes.push("vegetarian");
  if (/\b(gluten[\s-]?free|coeliac|celiac)\b/.test(t)) notes.push("gluten-free");
  if (/\bhalal\b/.test(t)) notes.push("halal");
  if (/\bkosher\b/.test(t)) notes.push("kosher");
  if (/\b(high\s?chair|highchair)\b/.test(t)) notes.push("high chair");
  if (/\b(wheelchair|accessible|accessibility|mobility)\b/.test(t)) notes.push("wheelchair access");
  if (/\b(pram|stroller|buggy|pushchair|pushpram)\b/.test(t)) notes.push("pram space");
  if (/\b(birthday|anniversary|engagement|celebration|celebrating)\b/.test(t)) notes.push("special occasion");
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
  "around", "have", "get", "something", "there", "here",
  // acknowledgements / fillers a caller gives INSTEAD of a name ("oh, that's
  // great, cheers" / "no worries" / "lovely, thanks") — never a name, so re-ask
  // rather than booking the ack as the customer name (CHIRP run 3976308 booked
  // "That's Great Cheers"; also the British "Uh-huh"/"Brilliant" artifacts).
  "oh", "that", "thats", "cheers", "great", "lovely", "perfect", "wonderful",
  "brilliant", "awesome", "excellent", "fantastic", "marvellous", "marvelous",
  "ta", "cool", "righto", "right", "worries", "good", "grand", "nice", "beauty",
  "beaut", "ripper", "yay", "huh", "uhhuh", "uh-huh", "sorry", "alright", "got",
  // the slot words the confirm beat offers ("what would you like to change — the
  // day, the time, or the number?") must never be stored as the NAME.
  "day", "date", "time", "number", "people", "party", "person", "booking",
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

export function parseName(text: string): string | null {
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
  return /\b(yes|yeah|yep|yup|sure|please|correct|that'?s right|go on|sounds good|perfect|lovely|good|ok|okay|do it|book it|that works|either|first one|second one|spot on|too right|righto|right)\b/.test(t)
    && !/\bno\b|\bnot\b|\bdon'?t\b|\bnope\b|\bnah\b/.test(t);
}

/** A short negative ("no", "nah", "neither", "that won't work"). */
export function isNo(text: string): boolean {
  const t = normalise(text);
  return /\b(no|nah|nope|neither|won'?t work|doesn'?t work|can'?t do|another|different|something else|not that|not really|nope)\b/.test(t);
}

/** The caller asks us to repeat / read the booking back ("say that again",
 * "what did I book?", "can you run that by me?"). */
export function detectRepeatRequest(text: string): boolean {
  const t = normalise(text);
  return (
    /\b(say (that|it) again|repeat (that|it|the booking)?|come again|one more time|run (that|it) by me|go over (that|it) again|read (that|it|the booking|the details) back|read (that|it) out)\b/.test(t) ||
    /\bwhat (did|'?d) (i|we) (book|get|say|put)\b/.test(t) ||
    /\bwhat('?s| is| was) (the|my) (booking|reservation|time|details)\b/.test(t) ||
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
