/**
 * Deterministic slot extraction for the reservation state machine. Interpreting
 * is state-directed: the machine knows which slot it's collecting and parses the
 * answer for THAT slot, which is far more reliable than blind multi-slot parsing.
 * The LLM (voice layer) only helps with messy multi-slot openers.
 */

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  couple: 2, pair: 2, dozen: 12,
};

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
const BOOK_RE = /\b(book|reserve|reservation|booking|table|get us in|fit us in|dinner|lunch)\b/;

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

/**
 * Extract a party size. Handles "four", "for 4", "party of six", "table for 2",
 * "just the two of us", "me and my wife" (2), "4 people". Returns null if none.
 */
export function parsePartySize(text: string): number | null {
  const t = normalise(text);
  if (!t) return null;
  if (/\b(just )?(me|myself) (and|&) (my )?(wife|husband|partner|mate|friend|mrs|missus)\b/.test(t)) return 2;
  if (/\bjust me\b|\bmyself\b|\bfor one\b|\bone person\b/.test(t)) return 1;

  // "party of N", "group of N", "for N", "table for N", "N people/guests/pax"
  const patterns = [
    /\b(?:party|group|table|booking)\s+(?:of|for)\s+([a-z0-9]+)\b/,
    /\bfor\s+([a-z0-9]+)\b/,
    /\b([a-z0-9]+)\s+(?:people|persons|guests|pax|of us|adults|heads|covers)\b/,
    /^([a-z0-9]+)$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const raw = m[1]!;
      const n = /^\d+$/.test(raw) ? Number(raw) : NUM_WORDS[raw];
      if (n && Number.isInteger(n) && n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

const NON_NAME = new Set([
  "yes", "yeah", "yep", "no", "nah", "nope", "ok", "okay", "sure", "thanks",
  "thank", "please", "um", "uh", "hmm", "hi", "hello", "hey", "mate", "table",
  "booking", "reservation", "name", "the", "for", "under", "its", "it", "a",
]);

/**
 * Extract a customer name from a name-stage answer. Strips lead-ins ("it's Dave",
 * "the name's Dave", "put it under Dave"). Returns null if it isn't a plausible
 * name (so the machine re-asks rather than storing junk).
 */
export function parseName(text: string): string | null {
  let t = text.trim().replace(/[.,!?]/g, "");
  t = t.replace(
    /^(?:yeah|yep|yup|nah|no|um|uh|ah|oh|so|well|ok|okay)[,\s]+/i,
    "",
  );
  t = t.replace(
    /\b(?:my name is|the name is|name'?s|name|it'?s|its|it is|this is|i'?m|i am|call me|put it under|put it down|under|for)\b/gi,
    " ",
  );
  t = t.replace(/[^a-zA-Z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 3) return null;
  if (words.some((w) => NON_NAME.has(w.toLowerCase()))) return null;
  if (words.every((w) => w.replace(/[^a-z]/gi, "").length <= 1)) return null;
  if (t.length < 2 || t.length > 40) return null;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9", double: "", triple: "",
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
  return /\b(yes|yeah|yep|yup|sure|please|correct|that'?s right|go on|sounds good|perfect|lovely|good|ok|okay|do it|book it|that works|either|first one|second one)\b/.test(t)
    && !/\bno\b|\bnot\b|\bdon'?t\b/.test(t);
}

/** A short negative ("no", "nah", "neither", "that won't work"). */
export function isNo(text: string): boolean {
  const t = normalise(text);
  return /\b(no|nah|nope|neither|won'?t work|doesn'?t work|can'?t do|another|different|something else)\b/.test(t);
}
