import { getModifierGroups, listCategories, listItems } from "../domain/menu";
import { getOrderWithItems } from "../domain/orders";
import { speakCents } from "../money";
import type { OrderWithItems } from "../types";
import { executeTool, groupQuestion, type AgentContext, type AgentState } from "./tools";
import type { ToolCallRecord } from "./engine";

/**
 * Deterministic dialogue fast paths.
 *
 * The LLM does LANGUAGE UNDERSTANDING; this module does DIALOGUE CONTROL
 * for the predictable turns of an order call — single-word option answers,
 * "anything else? -> nah", the final "yep" — so those turns answer in
 * milliseconds instead of an LLM round-trip. Anything ambiguous falls
 * through to Claude untouched.
 *
 * Stage detection keys off the assistant's own previous line (which both
 * this module and the LLM produce), so no parallel state machine can drift
 * out of sync with what the caller actually heard.
 */

export interface FastPathResult {
  handled: boolean;
  say?: string;
  endCall?: boolean;
  toolCalls?: ToolCallRecord[];
  kind?: string;
}

const NOT_HANDLED: FastPathResult = { handled: false };

// ---------------------------------------------------------------- text utils

const FILLER_WORDS = new Set([
  "and", "on", "the", "a", "an", "please", "mate", "yeah", "yep", "with",
  "them", "it", "thanks", "cheers", "just", "for", "me", "um", "uh", "ah",
  "oh", "ta", "то", "of",
  // hesitation sounds STT renders as words ("Mm, two chicken meatbox") — never
  // part of a menu item, so strip them or they break the set-equality match.
  "mm", "mmm", "hmm", "hm", "er", "erm", "umm", "uhh", "eh",
  // "go"/"on" from casual "go on, a coke" (taking an upsell) and the Aussie
  // opener "I'll go a chicken kebab" — never a menu item or flavour token.
  "go", "gonna", "goin",
  // hedge words a caller sprinkles in ("MAYBE some chips and MAYBE a coke") —
  // never a menu item; without stripping, "maybe" left a leftover token that
  // broke the compound match and sent it to the LLM (live AU call MB1151).
  "maybe", "perhaps", "possibly",
]);

const SCOPE_ALL_WORDS = new Set(["both", "all", "each", "everything"]);

export { isFinished, isYes, normalise, WAIT_REGEX } from "./speech";
import { isFinished, isMenuRequest, isOptionsQuery, isSelectAll, isSpecialsRequest, isYes, normalise, WAIT_REGEX } from "./speech";
import { getActiveSpecials } from "../domain/specials";

/** A "yes" that ALSO carries an addition or change ("yeah, and a coke", "yes
 * but make it lamb", "yep also grab chips") — used to STOP the confirm fast
 * path from confirming + hanging up when the caller tacked on a last-second
 * change (audit 2026-09-24). Conservative: a benign verbose confirm that
 * happens to contain one of these words just falls to the LLM (which
 * confirms) — a harmless extra turn, never a dropped item. */
function carriesOrderChange(text: string): boolean {
  const t = normalise(text);
  return /\b(and|also|plus|as well|aswell|add|another|extra|forgot|one more|actually|instead|swap|change|make it|can i|could i|i'?ll|grab|chuck|throw)\b/.test(
    t,
  );
}

/** Items a caller can order right now — sold-out / unavailable items are
 * excluded so the fast path never resolves one and then fails the add. A
 * sold-out item silently dropped a compound line and half-completed a swap
 * (audit 2026-09-24); now it falls to the LLM, which says it's unavailable. */
async function orderableItems(ctx: AgentContext) {
  return (await listItems(ctx.db, ctx.restaurant.id)).filter(
    (i) => i.isAvailable && !i.isSoldOut,
  );
}

// ---------------------------------------------------------------- stages

function lastLine(state: AgentState): string {
  return normalise(state.lastAssistantText);
}

function atConfirmStage(state: AgentState): boolean {
  // Both close styles: item read-back ends "Correct?", total-only close ends
  // "Sound good?" (warm) — older calls / LLM rephrases still say "Confirm?".
  // Either way the next "yes" is the final confirmation.
  return /(correct|confirm|sound good|all good)\s*$/.test(lastLine(state));
}

function atAnythingElseStage(state: AgentState): boolean {
  // "Anything else?", "Anything else for you?", "Was there anything else?" —
  // the LLM varies the wording, so match the phrase anywhere in the line.
  return /anything else/.test(lastLine(state));
}

/** The assistant's last line invites the caller to (re)state what they want —
 * "anything else?", a re-ask ("sorry, say that again?"), or an open "what can I
 * get you?". After ANY of these a fresh item/drink must add fast, not fall to
 * the LLM just because the words weren't exactly "anything else" (e.g. a drink
 * ordered right after a "say that again" was silently dropped, 2026-09-19). */
function atOpenPromptStage(state: AgentState): boolean {
  const l = lastLine(state);
  return (
    /anything else/.test(l) ||
    /say that again|come again|didn'?t (?:catch|get)|what was that|pardon|not following|not sure i (?:got|caught|follow)/.test(l) ||
    /what (?:can|could) i get|what would you like|what.?ll it be|what else|what are you after/.test(l) ||
    // The LLM (or a rephrase) invited another item without the exact words
    // "anything else" — "Want another one?", "Anything more?", "Add anything?".
    // A clean item named next must add fast, not fall to the LLM, which may
    // acknowledge the add in words but drop the tool call (live call MB1140:
    // "Want another one?" -> "Falafel also" -> falafel silently lost).
    /want (?:you )?(?:another|anything|something|more)|(?:fancy|like|need) (?:another|anything|something|more)|another one|anything (?:more|to add)|more for you|add (?:anything|something)/.test(l)
  );
}

function atNameStage(state: AgentState): boolean {
  const l = lastLine(state);
  if (!/\bname\b/.test(l)) return false;
  // The assistant is asking for the customer's name — our canonical line OR
  // any LLM rephrase ("I still need a name for the order", "what was the
  // name", "what's your name"). Broad so the name answer is fast whoever
  // asked. Excludes lines that merely contain a name (the close has none).
  return /(name shall i put it under|name for the order|need a name|get a name|grab a name|your name|the name|whats? the name|what.{0,8}name)/.test(l);
}

function atGreetingStage(state: AgentState): boolean {
  // Start of call: nothing ordered yet. Keyed off state, not the greeting's
  // exact words — the LLM varies its opener ("what can I get started for
  // you?"), and the first menu item must add fast however it greeted.
  return !state.draftOrderId;
}

// Instant reply to a bare greeting at the start. Not "what can I get you?"
// (the opening line already said that) — a fresh, human hand-off to ordering.
const GREETING_ACK = "What can I get for you?";

const GREETING_WORDS = new Set([
  "hi", "hey", "hello", "heya", "hiya", "gday", "yo", "howdy", "there", "mate",
  "hows", "it", "going", "morning", "afternoon", "evening",
  "how", "ya", "you", "goin", "doin", "doing", "today", "well", "good",
]);

/** The whole utterance is just a greeting — no order content. */
function isGreetingOnly(text: string): boolean {
  const toks = normalise(text)
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w));
  return toks.length > 0 && toks.length <= 4 && toks.every((t) => GREETING_WORDS.has(t));
}

// Words that make an opener pure INTENT ("I'd like to place an order for a
// takeaway") with no actual item — order verbs + order-type/format words.
const INTENT_WORDS = new Set([
  "order", "ordering", "place", "placing", "get", "getting", "grab", "have",
  "like", "want", "would", "i", "id", "ill", "can", "could", "make", "start",
  "takeaway", "take", "away", "pickup", "pick", "up", "delivery", "dinein",
  "dine", "collect", "collection", "food", "some", "something", "lunch",
  "dinner", "meal", "to", "an", "a",
]);
const ORDER_VERBS = new Set([
  "order", "ordering", "place", "placing", "takeaway", "pickup", "delivery",
  "collect", "collection",
]);

/**
 * The opener is JUST an intent to order with no item named ("hi, I'd like to
 * place an order", "can I order for takeaway?") — answer like a person
 * ("What can I get for you?") instead of a ~2s LLM pleasantry. Requires an
 * order verb so a stray unknown word isn't mistaken for intent.
 */
function isOrderIntentOnly(text: string): boolean {
  const toks = normalise(text)
    .split(" ")
    .map((w) => w.replace(/'/g, "")) // "i'd" -> "id"
    .filter(Boolean);
  if (toks.length === 0 || toks.length > 14) return false;
  const content = toks.filter(
    (w) => !FILLER_WORDS.has(w) && !INTENT_WORDS.has(w) && !GREETING_WORDS.has(w),
  );
  return content.length === 0 && toks.some((w) => ORDER_VERBS.has(w));
}

// ---------------------------------------------------------------- item match

const QTY_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, "1": 1, "2": 2, "3": 3,
  "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  // common multiplier words ("double chicken kebab", "a pair of", "triple")
  double: 2, pair: 2, triple: 3,
  // "a dozen falafel", "eleven/twelve wings" — larger counts a caller may say.
  dozen: 12, eleven: 11, twelve: 12,
};

/** Edit distance <= 1 (one insert/delete/substitute) for STT spelling wobble
 * like "chili" vs "chilli". Only used as a fallback on longer tokens. */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff++;
    return diff === 1;
  }
  // lengths differ by 1: check for a single insertion
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, skips = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else { skips++; j++; if (skips > 1) return false; }
  }
  return true;
}

/** Singularise a token for menu matching ("meatboxes" -> "meatbox"). */
function singular(w: string): string {
  if (w.endsWith("es") && w.length > 3) return w.slice(0, -2);
  if (w.endsWith("s") && w.length > 2) return w.slice(0, -1);
  return w;
}

interface ItemMatch {
  menuItemName: string;
  quantity: number;
  /** Inline option words spoken with the item ("LARGE chips") to apply to it —
   * dropped harmlessly if the item has no such option ("large" on a meatbox). */
  inlineOptions?: string[];
}

// Ordering verbs, greeting openers, order-type/format words and vague pointers
// a caller wraps the item name in — stripped so only the item (+ quantity)
// remains. None appear in a menu item name.
const ITEM_STRIP = new Set([
  "grab", "get", "can", "i", "want", "would", "like", "have", "id",
  "hey", "hi", "hello", "ok", "okay", "so", "look", "see", "gimme", "give",
  "us", "could", "lemme", "let",
  "to", "order", "ordering", "wanna", "gonna", "ill", "yeah", "yep",
  "actually", "start", "reckon", "do", "doing", "after", "im", "we",
  // "I'd like to PLACE AN ORDER FOR a chicken kebab" — without these the item
  // never matched and the whole first turn fell to the ~2.4s LLM (MB1129).
  "place", "for", "an", "please",
  // more Aussie "add it" openers a caller wraps the item in ("chuck us a...",
  // "throw a ... in", "hook us up with a...", "I'll take a...", "can you do us")
  "you", "take", "taking", "chuck", "throw", "hook", "grabbing", "getting",
  "in", // particle in "throw a ... in", "chuck it in" — no menu item token is "in"
  // greeting openers STT commonly prepends ("g'day", rendered "good day")
  "good", "day", "gday", "g'day", "morning", "afternoon", "evening",
  "howdy", "yo", "heya", "hiya", "hows", "howsit", "there", "cheers",
  // order-type / format words a caller wraps the item in ("a takeaway
  // chicken kebab", "pickup order"). None appear in a menu item name.
  "takeaway", "pickup", "pick", "up", "delivery", "delivered", "dinein",
  "dine", "collection", "collect", "meal",
  // NOTE: "sandwich"/"wrap"/"roll" are NOT stripped here — they mean "kebab"
  // and are remapped to it in matchMenuItem ("falafel sandwich" -> Falafel Kebab).
  // vague pointers / STT noise a caller sprinkles around the item name
  // ("one of those chicken meatbox things", "some sort of kebab thing")
  "those", "thing", "things", "stuff", "this", "that", "kinda", "sorta",
  "sort", "bit", "your", "ya",
  // portion/quantity descriptors that aren't part of any item name ("SOME
  // chips", "a SERVE of chips", "a PORTION of rice") — live AU-call probe.
  "some", "serve", "serves", "serving", "servings", "portion", "order",
  // "add ANOTHER falafel", "falafel ALSO/TOO/AS WELL" — additive words a caller
  // tacks on when adding a second item mid-order. Without these the leftover
  // token made matchMenuItem bail and the add fell to the LLM, which
  // acknowledged it in words but never called add_order_item (live call MB1140:
  // "Falafel also" -> "Yep, sauce?" -> falafel silently dropped). NB "and" is
  // NOT stripped — menu labels normalise "&" to "and" (Fish & Chips) and the
  // compound-order splitter needs it; "as"/"well" appear in no item label.
  "also", "too", "aswell", "as", "well", "another",
]);

/** Strip the filler/ordering words and pull a leading quantity, leaving the
 * singularised item content tokens. null if nothing item-like remains. */
function parseItemUtterance(utterance: string): { itemTokens: string[]; quantity: number } | null {
  const tokens = normalise(utterance)
    .split(" ")
    .map((w) => w.replace(/'/g, "")) // "i'd" -> "id" so contractions strip
    .filter((w) => w && !FILLER_WORDS.has(w) && !ITEM_STRIP.has(w));
  if (tokens.length === 0) return null;
  let quantity = 1;
  const itemWords: string[] = [];
  let qtyTaken = false;
  for (const t of tokens) {
    if (!qtyTaken && QTY_WORDS[t] !== undefined) {
      quantity = QTY_WORDS[t]!;
      qtyTaken = true;
    } else {
      itemWords.push(t);
    }
  }
  if (itemWords.length === 0) return null;
  return { itemTokens: itemWords.map(singular), quantity };
}

/**
 * Deterministically recognise ONE clear menu item + quantity from a short
 * ordering utterance ("two chicken meatboxes"). Conservative: leftover
 * content words (a second item, inline options, unknown words) => null so
 * the LLM handles anything complex. Ambiguity ("meatbox" alone) => null.
 */
// "wrap"/"roll"/"sandwich" mean a KEBAB at this shop — "falafel wrap" = Falafel
// Kebab, "lamb roll" = Lamb Kebab, "chicken sandwich" = Chicken Kebab. On a
// retry they're remapped to "kebab" (so "falafel wrap" resolves to the kebab,
// NOT the falafel side). "plate" and other format words are just noise, stripped.
// Only applied AFTER the direct/alias pass, so real aliases ("chicken wrap")
// still win directly.
const KEBAB_WORDS = new Set(["wrap", "roll", "sandwich"]);
const STRIP_DESCRIPTORS = new Set(["plate"]);
const ITEM_DESCRIPTORS = new Set([...KEBAB_WORDS, ...STRIP_DESCRIPTORS]);
// Inline SIZE words a caller says with the item ("LARGE chips"). Applied as an
// option on items that have one (Chips' Size), dropped on items that don't.
const INLINE_OPTION_WORDS = new Set(["large", "small", "regular", "medium", "big", "reg", "lge", "sml"]);

/** Match a set of already-parsed item tokens against the menu, returning the
 * set of item names that match cleanly (space- and order-insensitive). Item
 * names' parentheticals ("Falafel (4 pieces)") are dropped so the caller's
 * bare form ("falafel") matches. */
function matchItemTokens(
  itemTokens: string[],
  items: { name: string; aliases: string[] }[],
): Set<string> {
  const matched = new Set<string>();
  const uttSquished = itemTokens.join("");
  if (!uttSquished) return matched;
  const uttSet = [...itemTokens].sort().join(" ");
  for (const item of items) {
    for (const label of [item.name, ...item.aliases]) {
      // Drop a "(4 pieces)"-style descriptor and filter fillers on the NAME
      // side, so item names carrying either ("Meatbox Burger with the Lot",
      // "Falafel (4 pieces)") match the caller's plain form.
      const nameToks = normalise(label.replace(/\([^)]*\)/g, " "))
        .split(" ")
        .filter((w) => w && !FILLER_WORDS.has(w) && w !== "meal")
        .map(singular);
      const nameSquished = nameToks.join("");
      const nameSet = [...nameToks].sort().join(" ");
      if (nameSquished && (nameSquished === uttSquished || nameSet === uttSet)) {
        matched.add(item.name);
      }
    }
  }
  return matched;
}

function matchMenuItem(
  utterance: string,
  items: { name: string; aliases: string[] }[],
): ItemMatch | null {
  const parsed = parseItemUtterance(utterance);
  if (!parsed) return null;
  const { itemTokens, quantity } = parsed;

  // Clean match: the utterance's content (minus quantity) is EXACTLY one menu
  // item's name — same words, any order. Anything with leftover words (a second
  // item, inline options like "large"/"garlic") is left to the LLM.
  let matched = matchItemTokens(itemTokens, items);
  let inlineOptions: string[] = [];
  if (matched.size !== 1) {
    // Retry treating wrap/roll/sandwich as "kebab" ("falafel wrap" -> Falafel
    // Kebab, "chicken kebab wrap" -> Chicken Kebab) and dropping plate/other
    // noise — only after the direct/alias pass, so "chicken wrap" still wins.
    const remapped = itemTokens
      .map((t) => (KEBAB_WORDS.has(t) ? "kebab" : t))
      .filter((t) => !STRIP_DESCRIPTORS.has(t));
    const uniq = [...new Set(remapped)];
    if (uniq.length > 0 && uniq.join(" ") !== itemTokens.join(" ")) {
      matched = matchItemTokens(uniq, items);
    }
  }
  if (matched.size !== 1 && itemTokens.includes("kebab") && itemTokens.includes("meat")) {
    // "a meat kebab" = the mixed(-meat) kebab. Resolve it to Mixed Kebab so a
    // compound like "chicken kebab and a meat kebab" adds INSTANTLY instead of a
    // ~5s LLM turn (Kevin AU test 2026-09-25) — this is the same item the LLM
    // itself picked. Only fires with "kebab" present, so "meat box"/"meatbox"
    // (a different family) is untouched.
    const remapped = itemTokens.map((t) => (t === "meat" ? "mixed" : t));
    matched = matchItemTokens(remapped, items);
  }
  if (matched.size !== 1) {
    // Retry stripping an inline SIZE word ("LARGE chips", "LARGE chicken
    // meatbox"), keeping it to apply as an option on the matched item — it maps
    // to Chips' Size, and is dropped harmlessly on an item without one.
    const sizeWords = itemTokens.filter((t) => INLINE_OPTION_WORDS.has(t));
    const rest = itemTokens.filter((t) => !INLINE_OPTION_WORDS.has(t) && !ITEM_DESCRIPTORS.has(t));
    if (sizeWords.length > 0 && rest.length > 0) {
      const m = matchItemTokens(rest, items);
      if (m.size === 1) {
        matched = m;
        inlineOptions = sizeWords;
      }
    }
  }
  if (matched.size !== 1) return null; // none or ambiguous -> LLM

  return { menuItemName: [...matched][0]!, quantity, inlineOptions };
}

interface FamilyMatch {
  familyWord: string;
  candidates: string[];
  variants: string[];
  quantity: number;
}

/**
 * A generic item family named without a variant ("a kebab" — the menu has
 * Chicken/Lamb/Mixed/Falafel Kebab). Returns the shared family word, the
 * candidate item names and the distinguishing variant words to offer. Fires
 * only when the caller's words are a subset shared by >=2 items that each add
 * exactly ONE distinguishing word — so "a kebab"/"a meatbox" clarify cleanly.
 */
function matchItemFamily(
  utterance: string,
  items: { name: string; aliases: string[] }[],
): FamilyMatch | null {
  const parsed = parseItemUtterance(utterance);
  if (!parsed) return null;
  const { itemTokens, quantity } = parsed;
  const uttSet = new Set(itemTokens);
  if (uttSet.size === 0) return null;
  const cands: { name: string; variant: string }[] = [];
  for (const item of items) {
    const nameToks = normalise(item.name)
      .split(" ")
      .filter((w) => w && !FILLER_WORDS.has(w) && w !== "meal")
      .map(singular);
    const nameSet = new Set(nameToks);
    if (itemTokens.every((t) => nameSet.has(t)) && nameToks.length === itemTokens.length + 1) {
      const variant = nameToks.find((t) => !uttSet.has(t));
      if (variant) cands.push({ name: item.name, variant });
    }
  }
  const variants = [...new Set(cands.map((c) => c.variant))];
  if (cands.length < 2 || variants.length < 2) return null;
  return { familyWord: itemTokens.join(" "), candidates: cands.map((c) => c.name), variants, quantity };
}

/** Resolve a caller's variant answer ("falafel", "the chicken one") to one of
 * the pending family's candidates. Exactly one match, or null. */
function resolveFamilyAnswer(answer: string, family: { candidates: string[]; familyWord: string }): string | null {
  const toks = new Set(
    normalise(answer).split(" ").filter((w) => w && !FILLER_WORDS.has(w)).map(singular),
  );
  if (toks.size === 0) return null;
  const familyToks = new Set(normalise(family.familyWord).split(" ").map(singular));
  const hits = family.candidates.filter((name) => {
    const variantToks = normalise(name)
      .split(" ")
      .filter((w) => w && !FILLER_WORDS.has(w))
      .map(singular)
      .filter((t) => !familyToks.has(t));
    return variantToks.some((v) => toks.has(v));
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** The assistant's last line asked "which meat?" for a specific family —
 * "Chicken, lamb, or mixed meatbox?", "Which meatbox — chicken, lamb, or mixed?"
 * Returns the family word (meatbox/kebab/burger) so a bare meat answer resolves
 * to "<meat> <family>" instead of re-clarifying. Input is already normalised. */
function familyFromMeatClarify(lastLineNorm: string): string | null {
  if (!/\b(chicken|lamb|mixed)\b/.test(lastLineNorm)) return null;
  if (!/\b(which|or)\b/.test(lastLineNorm)) return null;
  for (const fam of ["meatbox", "meat box", "kebab", "burger"]) {
    if (lastLineNorm.includes(fam)) return fam.replace(/\s+/g, "");
  }
  return null;
}

// ---------------------------------------------------------------- item swap

// A leading acknowledgement STT commonly prepends to a correction ("nah
// actually cancel that", "yeah change it to rice"). Shared by the correction
// patterns so the ack doesn't stop them matching.
const ACK = "(?:(?:nah|no|nope|yeah|yep|yup|um|uh|ah|oh|ok|okay|so|well)[,\\s]+)?";

// Item-type swap: "make one of them a lamb one", "change one to lamb", "swap
// one for a lamb", plus the single-item "make it a lamb", "change it to lamb",
// "can you make it lamb". Only ACTS when the target resolves to a same-type
// menu variant (via resolveSwapTarget); an OPTION word ("make it a fanta")
// finds no variant and falls through to the option-change path below.
const SWAP_RE = new RegExp(
  `^${ACK}(?:actually[,\\s]*)?(?:can\\s+(?:you|ya|we)\\s+)?(?:make|change|swap|turn)\\s+(?:one|1|it|that|mine)(?:\\s+of\\s+(?:them|those|these|the\\s+two))?\\s+(?:a\\s+|an\\s+|to\\s+a?\\s*|into\\s+a?\\s*|for\\s+a?\\s*)?(.+?)(?:\\s+one)?\\s*$`,
  "i",
);

// Change ONE option on the existing item ("make it a fanta", "change it to
// rice"): refers to "it"/"that" (a single item), captures the new option.
const CHANGE_RE = new RegExp(
  `^${ACK}(?:actually[,\\s]*)?(?:can\\s+(?:you|ya|we)\\s+)?(?:make|change|swap|turn)\\s+(?:it|that|mine)\\s+(?:to\\s+|into\\s+|for\\s+)?(?:a\\s+|an\\s+)?(.+?)(?:\\s+instead)?\\s*$`,
  "i",
);

// Remove a whole line: "cancel the coke", "scrap the kebab", "forget the
// drink", "scratch that". Captures the item phrase (empty / "that" / "it" ->
// the most recent line). Line-removal verbs only — ingredient removal ("no
// onion", "take the onion off") is REMOVAL_RE below.
const REMOVE_ITEM_RE = new RegExp(
  `^${ACK}(?:actually[,\\s]*)?(?:can\\s+(?:you|ya|we)\\s+)?(?:cancel|scrap|scratch|drop|delete|forget|ditch|lose|get\\s+rid\\s+of|remove)\\s*(?:the\\s+|that\\s+|my\\s+|a\\s+|an\\s+)?(.*?)\\s*(?:please|thanks|mate)?\\s*$`,
  "i",
);

// Leave an ingredient out: "no onion", "without pickles", "hold the tomato",
// "leave off the cheese", "take the onion off". Captures the ingredient.
const REMOVAL_RE = new RegExp(
  `^${ACK}(?:actually[,\\s]*)?(?:can\\s+(?:you|ya|we)\\s+)?(?:with\\s+)?(?:no|without|hold(?:\\s+the)?|leave\\s+(?:out|off)(?:\\s+the)?|skip(?:\\s+the)?|minus|nix|remove(?:\\s+the)?|take\\s+(?:out|off)(?:\\s+the)?|get\\s+rid\\s+of(?:\\s+the)?)\\s+(.+?)\\s*(?:off|out)?\\s*(?:please|thanks|mate|on\\s+(?:it|that|mine|both))?\\s*$`,
  "i",
);

// Change the quantity of the sole line: "make it two", "actually three",
// "just one", "change it to four". Captures the number word/digit.
const QTY_CHANGE_RE = new RegExp(
  `^${ACK}(?:actually[,\\s]*)?(?:can\\s+(?:you|ya|we)\\s+)?(?:make\\s+(?:it|that|em|them)|change\\s+(?:it|that)\\s+to|i'?ll\\s+(?:do|have|get|take)|lets?\\s+(?:do|make\\s+it)|do|just|only)\\s+(one|two|three|four|five|six|seven|eight|nine|ten|couple|\\d+)\\b`,
  "i",
);

/**
 * Resolve a swap target phrase to a same-TYPE menu-item variant of the source
 * line ("lamb" + "Chicken Meatbox" -> "Lamb Meatbox"): the target name must
 * contain every target word AND share a type word with the source (e.g.
 * "meatbox"), and differ from the source. Exactly one match, else null.
 */
function resolveSwapTarget(
  targetPhrase: string,
  sourceName: string,
  itemNames: string[],
): string | null {
  const tgt = normalise(targetPhrase)
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w))
    .map(singular);
  if (tgt.length === 0) return null;
  const srcTokens = new Set(normalise(sourceName).split(" ").map(singular));
  const cands = itemNames.filter((name) => {
    if (normalise(name) === normalise(sourceName)) return false;
    const nt = normalise(name).split(" ").map(singular);
    const nset = new Set(nt);
    return tgt.every((t) => nset.has(t)) && nt.some((t) => srcTokens.has(t));
  });
  return cands.length === 1 ? cands[0]! : null;
}

// ---------------------------------------------------------------- drinks

// A caller names a soft drink by its FLAVOUR ("a coke", "can of fanta") — the
// menu item is "Soft Drink Can"/"Soft Drink 1.25L" with the flavour as a
// required option. Resolve both in one step so drinks add instantly.
const DRINK_STRIP = new Set([
  "grab", "get", "can", "cans", "i", "want", "would", "like", "have", "id",
  "hey", "hi", "gimme", "give", "us", "could", "lemme", "let", "to", "order",
  "wanna", "gonna", "ill", "yeah", "yep", "actually", "im", "we", "just",
  "bottle", "bottles", "soft", "drink", "drinks", "softie", "fizzy", "cold", "of",
  // "chuck a coke in there", "and stick a fanta on as well"
  "chuck", "throw", "stick", "whack", "slap", "bang", "in", "there", "here",
  "another", "also", "too", "aswell", "as", "well", "on", "plus", "add",
]);
const BIG_HINTS = new Set(["bottle", "big", "large", "litre", "liter", "125"]);

async function matchDrink(
  ctx: AgentContext,
  utterance: string,
): Promise<{ menuItemName: string; flavourName: string; quantity: number } | null> {
  const raw = normalise(utterance).split(" ").filter(Boolean);
  const big = raw.some((t) => BIG_HINTS.has(t));
  const tokens = raw.filter((w) => !FILLER_WORDS.has(w) && !DRINK_STRIP.has(w) && !BIG_HINTS.has(w));
  let quantity = 1;
  const flavourWords: string[] = [];
  let qtyTaken = false;
  for (const t of tokens) {
    if (!qtyTaken && QTY_WORDS[t] !== undefined) { quantity = QTY_WORDS[t]!; qtyTaken = true; }
    else flavourWords.push(t);
  }
  if (flavourWords.length === 0) return null;
  // A bare decline/affirmation answering "…or a drink?" is NOT a drink order —
  // but the option "Coke NO Sugar" literally contains "no", so a lone "no" would
  // match it and add a phantom Coke (live call MB1154: "Mm, no" -> Coke No Sugar
  // silently added). Drop pure answer-words; keep "no"/"not" only as part of a
  // "no sugar" qualifier (a real flavour word must remain for a match).
  const ANSWER_WORDS = new Set([
    "no", "nah", "nope", "not", "none", "na", "naw",
    "yes", "yeah", "yep", "yup", "nothing", "thanks", "thank", "ta", "cheers",
  ]);
  const hasSugar = flavourWords.includes("sugar");
  const flavourWordsClean = flavourWords.filter(
    (w) => !ANSWER_WORDS.has(w) || (hasSugar && (w === "no" || w === "not")),
  );
  if (flavourWordsClean.length === 0) return null;
  const items = await orderableItems(ctx);
  const drink = items.find((i) =>
    /soft drink/i.test(i.name) && (big ? /1\.?25|litre|liter/i.test(i.name) : /can/i.test(i.name)),
  );
  if (!drink) return null;
  const groups = await getModifierGroups(ctx.db, drink.id);
  const flav = groups.find((g) => /flavou?r/i.test(g.name));
  if (!flav) return null;
  const opts = flav.modifiers.filter((m) => m.isAvailable).map((m) => ({ id: m.id, name: m.name }));
  // "No sugar" synonyms: callers say it many ways ("diet coke", "coke zero",
  // "coke without sugar", "sugar-free coke"). Normalise the signal word to the
  // tokens the flavour actually carries ("no"/"sugar") so they resolve to the
  // "No Sugar" variant instead of a ~2s LLM turn (India/AU 2026-09-26).
  const NOSUGAR_SIGNALS = new Set(["diet", "zero", "sugarfree", "sugarless", "lite", "light", "without", "sf"]);
  let fw = flavourWordsClean;
  if (fw.some((w) => NOSUGAR_SIGNALS.has(w))) {
    fw = fw.filter((w) => !NOSUGAR_SIGNALS.has(w));
    for (const need of ["no", "sugar"]) if (!fw.includes(need)) fw.push(need);
  }
  const match = matchOptions(fw.join(" "), opts);
  if (!match || match.ids.length === 0) return null;
  let flavourId: string;
  if (match.ids.length === 1) {
    flavourId = match.ids[0]!;
  } else {
    // "coke no sugar" can match BOTH "Coke" and "Coke No Sugar" -> pick the MOST
    // specific: the option sharing the most words with what was said. Plain "a
    // coke" (no extra words) still resolves to "Coke" inside matchOptions.
    const want = new Set(fw.map(singular));
    const ranked = match.ids
      .map((id) => ({
        id,
        score: contentTokens(opts.find((o) => o.id === id)?.name ?? "").map(singular).filter((t) => want.has(t)).length,
      }))
      .sort((a, b) => b.score - a.score);
    if (ranked[0]!.score === (ranked[1]?.score ?? -1)) return null; // genuine tie -> LLM
    flavourId = ranked[0]!.id;
  }
  const flavourName = opts.find((o) => o.id === flavourId)?.name;
  if (!flavourName) return null;
  return { menuItemName: drink.name, flavourName, quantity };
}

// ---------------------------------------------------------------- read-back

const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve"];

function numWord(n: number): string {
  return NUM_WORDS[n] ?? String(n);
}

function pluralise(name: string, qty: number): string {
  if (qty === 1) return name;
  if (/(?:s|x|ch|sh)$/i.test(name)) return `${name}es`;
  return `${name}s`;
}

/** Terse spoken read-back: "Two Chicken Meatboxes, garlic on both. Correct?" */
export function terseReadback(order: OrderWithItems): string {
  const items = order.items;
  // Sorted: modifier row order from the DB is not deterministic. Spoken
  // text must carry no symbols ("&" etc — the TTS reads every character).
  const modsOf = (i: (typeof items)[number]) =>
    i.modifiers
      .map((m) =>
        m.nameSnapshot.replace(/\s+sauce$/i, "").replace(/\s*&\s*/g, " and ").toLowerCase(),
      )
      .sort();

  // Compression: every line shares the identical single modifier list.
  const first = items[0] ? modsOf(items[0]).join(", ") : "";
  const allShareMods =
    items.length > 1 && first !== "" && items.every((i) => modsOf(i).join(", ") === first);

  const parts = items.map((i) => {
    let line = `${numWord(i.quantity)} ${pluralise(i.nameSnapshot, i.quantity)}`;
    if (!allShareMods) {
      const mods = modsOf(i);
      if (mods.length > 0) line += ` with ${mods.join(" and ")}`;
    }
    for (const r of i.removals) line += `, no ${r}`;
    return line;
  });
  let text = parts.join(", ");
  if (allShareMods) {
    text += `, ${first} on ${items.length === 2 ? "both" : "all"}`;
  }
  return `${text}. Correct?`;
}

// A drink is the most-forgotten, highest-value add-on. When the order has food
// but NO drink yet, fold ONE suggestion into the existing "Anything else?" —
// no extra turn, one-word decline, once per call. Every other time it's the
// plain "Anything else?" (stage detection still matches — the phrase is there).
const HAS_DRINK_RE =
  /\b(drink|coke|cola|fanta|sprite|solo|lemonade|water|ayran|juice|tea|milkshake|shake|boba)\b/i;

// Same three words every single time ("Anything else?" ... "Anything else?") is
// the clearest "I'm a robot" tell on a multi-item order. Vary the tail so it
// sounds like a person — every variant still contains "anything else" so the
// finish/stage detection keeps matching. Keyed off item count (deterministic,
// no extra state): the phrase naturally changes as the order grows.
const ANYTHING_ELSE_VARIANTS = [
  "Anything else?",
  "Anything else for you?",
  "Anything else with that?",
];

async function anythingElse(ctx: AgentContext, state: AgentState): Promise<string> {
  const order = state.draftOrderId ? await getOrderWithItems(ctx.db, state.draftOrderId) : null;
  // First food-only order of the call: fold in ONE drink suggestion (once, no
  // extra turn, one-word decline).
  if (
    !state.suggestedAddon &&
    order &&
    order.items.length > 0 &&
    !order.items.some((i) => HAS_DRINK_RE.test(i.nameSnapshot))
  ) {
    state.suggestedAddon = true;
    return "Anything else, or a drink?";
  }
  const n = order?.items.length ?? 0;
  return ANYTHING_ELSE_VARIANTS[n % ANYTHING_ELSE_VARIANTS.length]!;
}

// A change/removal ("make it lamb", "cancel the coke", "make it two") should be
// dealt with casually — a quick "no worries" so the caller knows it registered,
// then straight on. Keeps "anything else" in the line so stage detection holds.
async function anythingElseAfterChange(ctx: AgentContext, state: AgentState): Promise<string> {
  const rest = await anythingElse(ctx, state);
  return `No worries — ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
}

/** Spoken category list for a "what's on the menu?" ask — read the categories,
 * not every item, then invite the order. Built from the live categories so it
 * stays accurate if the menu changes. */
async function menuSummary(ctx: AgentContext): Promise<string> {
  const cats = await listCategories(ctx.db, ctx.restaurant.id);
  const names = cats.map((c) => c.name.replace(/\s*&\s*/g, " and ").toLowerCase());
  if (names.length === 0) return "What can I get for you?";
  const list =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `We've got ${list}. What are you after?`;
}

/**
 * Answer "what are today's specials?" INSTANTLY from the daily_specials table
 * (the same source get_daily_specials reads) instead of a ~5s LLM+tool turn.
 * States them plainly and truthfully — never invents one; "No specials on
 * today." when there are none (matches the tool's guidance). Ordering a special
 * afterwards still falls to the LLM (order_special), which is correct.
 */
async function answerSpecials(ctx: AgentContext): Promise<string> {
  const specials = await getActiveSpecials(ctx.db, ctx.restaurant.id, ctx.now());
  if (specials.length === 0) return "No specials on today.";
  const parts = specials.map((s) => `the ${s.name} for ${speakCents(s.priceCents)}`);
  const list =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Today we've got ${list}.`;
}

/**
 * Total-only close (owner rule: no item recital — state the grand total once
 * with the name and type, confirm once). "That's 42 dollars 80, takeaway for
 * Sam. Confirm?"
 */
/** Naive spoken pluraliser for a menu item name ("chicken kebab" -> "chicken
 * kebabs", "meatbox" -> "meatboxes"); leaves already-plural names ("chips"). */
function pluralizeItem(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith("s")) return n;
  return /(x|ch|sh)$/.test(n) ? `${n}es` : `${n}s`;
}

export function spokenClose(order: OrderWithItems): string {
  const type = order.orderType === "dine_in" ? "dine-in" : "takeaway";
  const name = realName(order);
  // Spell the name back ONLY when it looks garbled / likely mis-heard — NOT on
  // every call (Kevin 2026-09-24: "if the name's misspelled only repeat as
  // alphabets, don't do it in all calls"). A normal-looking name (common or not)
  // just confirms fast; a dubious one (no vowels, too short, repeated letters)
  // gets spelled so it's caught. "Sound good?" stays the ender atConfirmStage
  // matches.
  const first = name.split(/\s+/)[0]?.toLowerCase() ?? "";
  const spell = name && !COMMON_NAMES.has(first) && looksMisheard(first);
  const spelled = spell ? `, that's ${spellName(name)}` : "";
  // LARGE ORDER -> read the ITEMS back, not just the total, so an inflated or
  // mis-heard order is caught before it's locked. On a garbled line a caller can
  // repeat an item and each repeat gets added (India call MB1150: "pair of
  // chicken kebab" said a few times -> 7 kebabs / $108 confirmed on the total
  // alone). Only for genuinely big orders (5+ lines or $80+); small orders keep
  // the fast total-only close (owner rule). Kevin 2026-09-26.
  if (order.items.length > 0 && (order.items.length >= 5 || order.totalCents >= 8000)) {
    const items = order.items
      .map((i) => (i.quantity > 1 ? `${i.quantity} ${pluralizeItem(i.nameSnapshot)}` : i.nameSnapshot.toLowerCase()))
      .join(", ");
    return `That's ${items} — ${speakCents(order.totalCents)}, ${type}${name ? ` for ${name}` : ""}${spelled}. Correct?`;
  }
  return `That's ${speakCents(order.totalCents)}, ${type}${name ? ` for ${name}` : ""}${spelled}. Sound good?`;
}

/** A captured name that looks garbled rather than like a real spoken name —
 * spell it back to confirm. Real names have a vowel and a sensible length; a
 * mis-hear tends to be very short, vowel-less, or a stutter ("mmm", "jj"). */
function looksMisheard(word: string): boolean {
  const w = word.replace(/[^a-z]/gi, "").toLowerCase();
  if (w.length < 3) return true; // too short to be sure ("jo", "ng")
  if (!/[aeiou]/.test(w)) return true; // no vowel -> almost certainly garbled
  if (/(.)\1\1/.test(w)) return true; // 3+ of the same letter in a row
  return false; // looks like a normal name -> confirm fast, no spelling
}

// Common first names the STT catches reliably (and that the keyterm biasing
// already boosts) — no need to spell these back, keeping the confirm fast.
const COMMON_NAMES = new Set([
  "kevin", "david", "dave", "john", "michael", "mike", "james", "jim", "daniel", "dan",
  "sam", "ben", "chris", "luke", "jack", "ryan", "josh", "matt", "matthew", "tom",
  "thomas", "nick", "nicholas", "steve", "stephen", "mark", "paul", "peter", "pete",
  "andrew", "andy", "jason", "adam", "aaron", "jake", "george", "harry", "will",
  "william", "oliver", "noah", "liam", "ethan", "joe", "joseph", "tony", "anthony",
  "rob", "robert", "rick", "richard", "greg", "scott", "sean", "shane", "brad", "brett",
  "sarah", "emma", "zoe", "jess", "jessica", "emily", "sophie", "sophia", "olivia",
  "kate", "katie", "amy", "anna", "hannah", "laura", "rachel", "lisa", "mia", "ava",
  "grace", "ella", "lily", "chloe", "ruby", "charlotte", "isla", "maria", "sue", "susan",
  "ali", "mo", "sara", "leah", "megan", "beth", "claire", "kim", "jade", "holly",
]);

/** A name spelled letter-by-letter for the spoken read-back ("Kevin" ->
 * "K. E. V. I. N"). Periods make the TTS pronounce each letter. */
function spellName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, "").toUpperCase().split("").join(". "))
    .filter(Boolean)
    .join(", ");
}

/** The order's real customer name, or "" — a literal "Unknown" (a default the
 * LLM sometimes writes when it never actually asked) counts as no name, so we
 * ask for it rather than reading "for Unknown" back to the caller. */
function realName(order: OrderWithItems): string {
  const n = order.customerName.trim();
  // Placeholder / non-name defaults the LLM sometimes writes ("Customer",
  // "Caller", "placeholder") or a connector captured off a hesitation ("And")
  // count as NO name — ask for a real one rather than reading it back (live AU
  // calls MB1129/1135/1136/1137: "for Caller", "for placeholder", "for And").
  return /^(unknown|customer|the customer|a customer|guest|caller|the caller|placeholder|pending|pending order|tbd|none|no name|na|n\/a|hello|testing|test|and|another|new|new order|order|anything|anything else|nothing|something|whatever|everything|anyone|someone|dunno|doesn'?t matter|don'?t mind)$/i.test(n)
    ? ""
    : n;
}

// ---------------------------------------------------------------- name capture

/**
 * Extract a spoken customer name -> title case, or null if it doesn't look
 * like a name (too long, too many words, empty after cleaning).
 */
function cleanName(text: string): string | null {
  // Strip a leading acknowledgement ("yeah, it's Dave", "nah Dave") FIRST — a
  // leading "yeah" would otherwise make isYes() fire and reject a real name.
  const deAck = text
    .trim()
    .replace(/^(?:yeah|yep|yup|nah|no|nope|ok|okay|um|uh|ah|oh|so|well|alright|righto)[,\s]+/i, "")
    // ...and a TRAILING ack/confirm ("Kevin. Yes.", "Dave, thanks") — otherwise
    // isYes() below fires on the trailing "yes" and rejects the real name (MB1129).
    .replace(/[\s,.]+(?:yeah|yep|yup|yes|ok|okay|sure|correct|thanks|thank you|cheers|please)\b\.?\s*$/i, "");
  // A change / question / request phrase is the caller ACTING on the order, not
  // giving a name ("can you change the falafel for chicken", "make it lamb",
  // "what drinks do you have") — live India call MB1123 read back "for Can You
  // Change". Never capture it as the name; hand it to the LLM to act on.
  if (
    /^(?:can|could|would|will)\s+(?:you|ya|we|i)\b/i.test(deAck) ||
    /\b(?:change|swap|cancel|instead|actually)\b/i.test(deAck) ||
    /^(?:make|add|remove|get)\s+(?:it|that|me|a|an|the|some)\b/i.test(deAck) ||
    /^(?:what|which|how|why|do|does|is|are)\b/i.test(deAck)
  ) {
    return null;
  }
  // Only WITHOUT an explicit name lead-in is a yes/finish answer taken as
  // "not a name" ("yep that's right" -> re-ask). With a lead-in ("it's Dave",
  // "for Dave") the name is trusted even if the sentence opened with "yeah".
  const hasLeadIn =
    /\b(?:it'?s|it is|name'?s|names|the name is|name is|under|put it under|for|this is)\b/i.test(deAck);
  if (!hasLeadIn && (isFinished(deAck) || isYes(deAck))) return null;
  const cleaned = deAck
    .replace(
      /\b(my name is|the name is|name is|name'?s|names|name|it'?s|its|it is|it|this is|i'?m|i am|call me|put it down|put it under|put|down|under|for|the|just|here|my|thanks|thank you|cheers|please|mate|yes|yeah|yep|yup|no|nah|nope|sure|correct|ok|okay)\b/gi,
      " ",
    )
    .replace(/[^a-zA-Z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 3) return null;
  if (cleaned.length < 2 || cleaned.length > 40) return null;
  // Compound answer (name + order type/timing/size, e.g. "Daniel, pickup
  // ASAP") -> let the LLM set all the fields; don't guess a name from it.
  // Also reject a hesitation / punctuation-only "word" ("Uh-" read back as
  // "for Uh-" on live India call) — normalise to bare letters before the check.
  if (
    words.some((w) => {
      const bare = w.toLowerCase().replace(/[^a-z']/g, "");
      return !bare || NON_NAME_WORDS.has(bare) || QTY_WORDS[bare] !== undefined;
    })
  ) {
    return null;
  }
  // An all-single-letter "name" ("J", "J J") is almost always a garbled line,
  // not a real name — never read back "for J J" (live India call). Re-ask.
  if (words.every((w) => w.replace(/[^a-zA-Z]/g, "").length <= 1)) return null;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// Caller volunteers a name at "anything else?" with an explicit lead-in
// ("it's Kevin", "under Sam", "the name's Dave") — a bare unknown word stays
// with the LLM (could be a garbled item, not a name).
const NAME_LEADIN_RE =
  /^(?:it'?s|its|name'?s|names|the name is|name is|under|put it under|this is)\s+(.+)$/i;

// Words that can follow a lead-in but are NOT names (order type, party size,
// acknowledgements) — reject so "it's for here" / "it's fine" never become names.
const NON_NAME_WORDS = new Set([
  "here", "there", "now", "later", "takeaway", "pickup", "pick", "up",
  "delivery", "dine", "dinein", "in", "yes", "no", "yeah", "nah", "ok",
  "okay", "done", "that", "all", "it", "fine", "good", "cool", "one", "two",
  "three", "four", "five", "six", "couple", "people", "us", "me",
  "asap", "tonight", "today", "tomorrow", "minutes", "mins", "oclock", "pm", "am",
  // greeting / connectivity / test noise a caller blurts at the name stage —
  // never the customer's name (live AU call MB1129 read "for Hello", "for
  // Testing Hello"). Re-ask instead of capturing these.
  "hello", "hi", "hey", "heya", "hiya", "hows", "testing", "test", "customer",
  "guest", "caller", "placeholder", "pending", "tbd", "hear", "you", "your", "sorry", "what", "who",
  // junk words a caller says INSTEAD of a name ("anything", "whatever") — never a
  // real name; capturing them put "Anything" on a live order (call MB1152).
  "anything", "nothing", "something", "whatever", "everything", "anyone", "someone", "dunno",
  // connectors/leads a caller trails off on, captured off a hesitation as a
  // "name" on live AU calls ("for And") — never a name.
  "and", "or", "another", "new", "order", "some", "the", "a", "an",
  // hesitation sounds STT renders as a "word" at the name step — never a name
  // ("Uh-" read back as "for Uh-" on a live India call).
  "uh", "uhh", "uhm", "um", "umm", "er", "erm", "hmm", "hm", "mm", "mmm",
  "ah", "eh", "oh", "ha",
]);

/**
 * The caller answered a REQUIRED option question (e.g. "chips and salad, or
 * rice and salad?") but it matched no option. Decide whether to re-ask the
 * SAME question instantly instead of burning a ~2s LLM turn — true when the
 * answer is a short, opaque phrase (typically a poor line garbling the option,
 * "chips and salad" -> "a chicken salad"). Conservative: any sign of a
 * different intent — a finish, a yes, a question, a correction, a second item
 * ("and a coke") — returns false so the LLM handles it properly.
 */
function isUnclearOptionAnswer(text: string): boolean {
  const t = normalise(text);
  if (!t) return false;
  if (t.split(" ").filter(Boolean).length > 5) return false; // a real sentence -> LLM
  if (isFinished(t) || isYes(t) || isOptionsQuery(t) || isSelectAll(t)) return false;
  // Words that signal a different intent (correction, extra item, question).
  if (
    /\b(no|not|don'?t|nah|cancel|change|actually|instead|make|swap|remove|without|hold|wait|repeat|again|and|also|add|another|plus|what|which|how|why|where|when|who|do|does|is|are|can|could|would|you)\b/.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- missing required

interface MissingGroup {
  orderItemId: string;
  menuItemId: string;
  groupId: string;
  groupName: string;
  maxSelect: number;
  options: { id: string; name: string }[];
  /** Modifier ids already chosen on the line (all groups). */
  chosenIds: string[];
}

async function missingRequiredGroups(
  ctx: AgentContext,
  order: OrderWithItems,
): Promise<MissingGroup[]> {
  const missing: MissingGroup[] = [];
  for (const item of order.items) {
    if (!item.menuItemId) continue;
    const groups = await getModifierGroups(ctx.db, item.menuItemId);
    for (const group of groups) {
      const minimum = group.required ? Math.max(1, group.minSelect) : group.minSelect;
      if (minimum < 1) continue;
      const chosenInGroup = item.modifiers.filter(
        (m) => m.groupNameSnapshot === group.name,
      ).length;
      if (chosenInGroup >= minimum) continue;
      missing.push({
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        groupId: group.id,
        groupName: group.name,
        maxSelect: group.maxSelect,
        options: group.modifiers.filter((m) => m.isAvailable).map((m) => ({ id: m.id, name: m.name })),
        chosenIds: item.modifiers.filter((m) => m.modifierId).map((m) => m.modifierId!),
      });
    }
  }
  return missing;
}

/**
 * Map utterance tokens to options of ONE group. Every non-filler,
 * non-scope token must resolve to exactly one option or the match fails.
 */
// Casual "put this on" verbs a caller wraps an option answer in ("chuck some
// chilli on both", "whack garlic on it"). Never part of a base/sauce option
// name, so filtering them from both sides is safe.
const ADD_VERBS = new Set([
  "chuck", "chucking", "put", "putting", "throw", "throwing", "stick",
  "whack", "slap", "gimme", "some", "bit", "lil", "little", "load", "add",
]);

// How real callers SAY an option vs how the menu spells it, so the fast path
// matches "barbecue"/"barbie" -> BBQ sauce, "ketchup" -> Tomato sauce, etc.
// Applied to the caller's words before matching against option content tokens.
const OPTION_SYNONYMS: Record<string, string> = {
  barbecue: "bbq", barbeque: "bbq", barbie: "bbq", "bar-b-q": "bbq", "barbi": "bbq",
  ketchup: "tomato", tomatoe: "tomato", tomatoes: "tomato", tomatos: "tomato",
  chili: "chilli", chilly: "chilli", chillies: "chilli", chillis: "chilli",
  garlicy: "garlic", garlicky: "garlic",
  // salad spelling / colloquial variants a caller says vs the menu's "Tabouli"
  // etc. — without these the whole salad turn fell to the ~2s LLM (MB1129).
  tabbouleh: "tabouli", tabouleh: "tabouli", taboule: "tabouli", tabbouli: "tabouli",
  tabuli: "tabouli", tabooli: "tabouli",
  lettuces: "lettuce", letuce: "lettuce", onions: "onion", pickle: "pickles", pickled: "pickles",
  // sauce spelling variants
  tahina: "tahini", tahin: "tahini", tahyni: "tahini", tahinni: "tahini",
  // plural a caller adds to a base option ("chips and SALADS" -> Chips & Salad)
  salads: "salad",
};

// Filler that wraps an option answer ("the chips ONE", "JUST garlic", "the
// large OPTION") — dropped so the real option word matches.
const OPTION_FILLER = new Set(["one", "ones", "just", "option", "the", "please", "sauce", "sauces"]);
function contentTokens(text: string): string[] {
  return normalise(text)
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w) && !ADD_VERBS.has(w) && !OPTION_FILLER.has(w))
    .map((w) => OPTION_SYNONYMS[w] ?? w);
}

function matchOptions(
  utterance: string,
  options: { id: string; name: string }[],
): { ids: string[]; scopeAll: boolean } | null {
  let scopeAll = false;
  const tokens = contentTokens(utterance).filter((t) => {
    if (SCOPE_ALL_WORDS.has(t)) {
      scopeAll = true;
      return false;
    }
    return true;
  });
  if (tokens.length === 0) return null;

  // Whole-utterance exact option name first (filler-insensitive, so
  // "chips and salad" matches "Chips & Salad").
  const joined = tokens.join(" ");
  for (const opt of options) {
    if (joined === contentTokens(opt.name).join(" ")) {
      return { ids: [opt.id], scopeAll };
    }
  }

  // token -> option (only unambiguous tokens usable)
  const tokenMap = new Map<string, Set<string>>();
  for (const opt of options) {
    for (const w of [...contentTokens(opt.name), contentTokens(opt.name).join("")]) {
      if (!tokenMap.has(w)) tokenMap.set(w, new Set());
      tokenMap.get(w)!.add(opt.id);
    }
  }
  // Each option's own content tokens, to resolve an ambiguous word to the
  // "plain" option ("chilli" -> "Chilli sauce", not "Sweet chilli sauce").
  const optContent = new Map(options.map((o) => [o.id, contentTokens(o.name)]));
  const resolve = (cands: Set<string>, token: string): string | null => {
    if (cands.size === 1) return [...cands][0]!;
    // Ambiguous: the option whose ENTIRE name is this one word is the default.
    const plain = [...cands].filter((id) => {
      const ct = optContent.get(id) ?? [];
      return ct.length === 1 && (ct[0] === token || within1(ct[0]!, token));
    });
    return plain.length === 1 ? plain[0]! : null; // still ambiguous -> LLM
  };
  const ids: string[] = [];
  for (const token of tokens) {
    let cands = tokenMap.get(token);
    if (!cands && token.length >= 5) {
      // STT spelling wobble ("chili" -> "chilli"): option tokens within one edit.
      const fuzzy = new Set<string>();
      for (const [key, optIds] of tokenMap) {
        if (key.length >= 5 && within1(key, token)) for (const id of optIds) fuzzy.add(id);
      }
      cands = fuzzy.size ? fuzzy : undefined;
    }
    if (!cands || cands.size === 0) return null; // unknown word -> LLM
    const chosen = resolve(cands, token);
    if (!chosen) return null; // genuinely ambiguous -> LLM
    if (!ids.includes(chosen)) ids.push(chosen);
  }
  if (ids.length === 0) return null;
  return { ids, scopeAll };
}

// ---------------------------------------------------------------- compound order

type RunFn = (
  name: string,
  input: Record<string, unknown>,
) => Promise<Awaited<ReturnType<typeof executeTool>>>;

interface QueuedItem {
  menuItemName: string;
  quantity: number;
  modifierNames?: string[];
}

/** Split a multi-item utterance on conjunctions ("A and B", "A, B and C",
 * "A plus B"). The one standalone menu item with "and" in its spoken form is
 * protected so it isn't torn apart; a segment that fails to resolve later just
 * sends the whole utterance to the LLM. */
function splitCompound(text: string): string[] {
  return normalise(text)
    .replace(/\bfish (?:and|n) chips\b/g, "fishandchips")
    // Split on conjunctions, and on "with" — EXCEPT "with rice/chips/salad",
    // which is a meatbox's BASE, not a separate side. Splitting "chicken
    // meatbox with rice" added a phantom $5 Rice side on top of the base
    // (audit 2026-09-24); leaving it unsplit sends the whole phrase to the LLM,
    // which sets the base correctly. "kebab with a coke" still splits (drink).
    .split(/\s+(?:and|plus|also|then)\s+|\s+with\s+(?!(?:a |an |the )?(?:rice|chips|salad)\b)|\s*,\s*/)
    .map((s) => s.replace(/fishandchips/g, "fish and chips").trim())
    .filter(Boolean);
}

/** Add the queued compound items one at a time. The first that needs a base is
 * left pending (executor stashes it) with the REST kept in the queue; returns
 * that base question. When the queue drains fully, returns null so the caller
 * moves on to "Anything else?". */
async function drainPendingQueue(
  ctx: AgentContext,
  state: AgentState,
  run: RunFn,
): Promise<{ say: string; kind: string } | null> {
  const queue = [...(state.pendingQueue ?? [])];
  while (queue.length > 0) {
    const it = queue.shift()!;
    const result = await run("add_order_item", {
      menuItemName: it.menuItemName,
      quantity: it.quantity,
      ...(it.modifierNames ? { modifierNames: it.modifierNames } : {}),
    });
    if (result.itemSavedAsPending && typeof result.ask === "string") {
      state.pendingQueue = queue; // the remaining items wait for this base answer
      return { say: result.ask, kind: "compound_pending" };
    }
    if (result.error) {
      state.pendingQueue = [];
      return null;
    }
  }
  state.pendingQueue = [];
  return null;
}

/** Recognise a COMPOUND order ("two chicken meatboxes and a mixed meatbox",
 * "a chicken kebab and a coke") and add every item deterministically. Each
 * segment must resolve to a SPECIFIC item (or a drink by flavour); if any is
 * ambiguous or unknown, returns null so the LLM handles the whole utterance. */
async function tryCompoundOrder(
  ctx: AgentContext,
  state: AgentState,
  text: string,
  run: RunFn,
): Promise<{ say: string; kind: string } | null> {
  // Drop filler-only fragments a hesitation leaves behind ("a chicken kebab
  // and, UM, and a coke" splits to [..., "um", ...]) so the hesitation doesn't
  // force the whole compound to the LLM (Kevin AU test 2026-09-25).
  const segments = splitCompound(text).filter((s) => {
    const toks = normalise(s).split(" ").filter((w) => w && !FILLER_WORDS.has(w) && !ITEM_STRIP.has(w));
    return toks.length > 0;
  });
  if (segments.length < 2 || segments.length > 5) return null;
  const items = await orderableItems(ctx);
  const catalog = items.map((i) => ({ name: i.name, aliases: i.aliases }));
  const resolved: QueuedItem[] = [];
  for (const seg of segments) {
    // Drink-by-flavour FIRST ("a can of coke") — otherwise the generic "coke"
    // alias adds the can and leaves the flavour pending (same rule as the
    // single-item path).
    const dm = await matchDrink(ctx, seg);
    if (dm) {
      resolved.push({ menuItemName: dm.menuItemName, quantity: dm.quantity, modifierNames: [dm.flavourName] });
      continue;
    }
    const im = matchMenuItem(seg, catalog);
    if (im) {
      resolved.push({ menuItemName: im.menuItemName, quantity: im.quantity });
      continue;
    }
    return null; // a segment didn't cleanly resolve -> LLM takes the whole thing
  }
  if (resolved.length < 2) return null;
  if (!ctx.settings.acceptingOrders) return null;
  if (!state.draftOrderId) {
    const draft = await run("create_order_draft", { orderType: "takeaway" });
    if (draft.error) return null;
  }
  state.pendingQueue = resolved;
  const pended = await drainPendingQueue(ctx, state, run);
  return pended ?? { say: "", kind: "compound_added" };
}

/**
 * Apologise only on the FIRST re-ask of a run — Kevin (2026-09-28): "if not
 * heard properly, say sorry and repeat; but don't ALWAYS say sorry — ask them
 * correctly and take the order." After the first miss, drop the apology and just
 * re-ask the specific question (the question itself is what moves the order on).
 */
function reaskLead(count: number): string {
  return count === 0 ? "Sorry, " : "";
}

/**
 * Kevin's rule (2026-09-22): when the caller talked OVER the assistant (an
 * overlap) and the resulting words couldn't be placed, say sorry and ask them to
 * repeat, instantly — rather than guessing on a garbled overlap or lagging on the
 * AI. Scoped to a real barge-in (not general STT noise, which would catch
 * legitimate short phrases like "still there?"). Capped so it can never loop.
 */
function garbledReask(
  state: AgentState,
  wasBarge: boolean,
  calls: ToolCallRecord[],
): FastPathResult | null {
  if (wasBarge && (state.garbledReaskCount ?? 0) < 2) {
    const first = (state.garbledReaskCount ?? 0) === 0;
    state.garbledReaskCount = (state.garbledReaskCount ?? 0) + 1;
    return {
      handled: true,
      // First miss apologises; a second in a row just asks again (no repeated
      // "sorry" — Kevin 2026-09-28).
      say: first
        ? "Sorry, I didn't catch that — could you say that again?"
        : "Could you say that again?",
      toolCalls: calls,
      kind: "garbled_reask",
    };
  }
  return null;
}

// ---------------------------------------------------------------- main entry

export interface FastPathOptions {
  /**
   * Probing a live STT PARTIAL (not the final transcript). The partial can be
   * a complete-looking PREFIX of a longer utterance, so skip new-item adds:
   * matching "two chicken meatboxes" off a partial could drop a trailing
   * "...and a coke". Item adds wait for the accurate committed transcript.
   * Answer turns (options, name, confirm, finish) stay eligible — they answer
   * a specific question and are inherently complete.
   */
  probe?: boolean;
}

export async function tryFastPath(
  ctx: AgentContext,
  state: AgentState,
  utterance: string,
  opts: FastPathOptions = {},
): Promise<FastPathResult> {
  const text = utterance.trim();
  // Did the caller talk OVER the assistant just before this? (Cleared each real
  // turn.) Used only at the fall-through to ask them to repeat an overlap.
  const wasBarge = Boolean(state.afterBarge);
  if (!opts.probe) state.afterBarge = false;
  if (!text || text.length > 80) return NOT_HANDLED; // long speech -> LLM
  const calls: ToolCallRecord[] = [];
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await executeTool(ctx, state, name, input);
    calls.push({ name: `fast:${name}`, input, result });
    return result;
  };
  const canText =
    ctx.settings.customerSmsEnabled && Boolean(ctx.callerNumber && ctx.callerNumber.startsWith("+"));

  // "Hang on" — acknowledge and wait, never prompt.
  if (WAIT_REGEX.test(normalise(text)) && !atConfirmStage(state)) {
    return { handled: true, say: "Yep.", toolCalls: calls, kind: "wait" };
  }

  // ---- caller asks what's on the menu ("what do you have?", "the menu?",
  // "no, tell me the menu") — read the categories back INSTANTLY instead of
  // deflecting with "what can I get you?" or a ~1.5s LLM turn (live AU call
  // NO_ORDER). Not at an option/confirm/name stage (those have their own flow).
  if (
    !opts.probe &&
    isMenuRequest(text) &&
    !atConfirmStage(state) &&
    !atNameStage(state) &&
    !state.pendingItem &&
    !state.pendingFamily
  ) {
    state.repeatOffered = false; // a menu ask moves past the "same as last time?" offer
    return { handled: true, say: await menuSummary(ctx), toolCalls: calls, kind: "menu" };
  }

  // ---- caller asks about today's specials/deals ("any specials today?", "what
  // deals do you have?"). The answer is deterministic (daily_specials table),
  // so answer INSTANTLY and RESUME whatever stage we interrupted, instead of a
  // ~5s LLM+tool turn (live call MB1152: "what specials do you have today?" =
  // 5.7s, asked mid name-capture). Committed transcript only (never a probe).
  if (!opts.probe && isSpecialsRequest(text)) {
    const said = await answerSpecials(ctx);
    if (atConfirmStage(state) && state.draftOrderId) {
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (order && order.items.length > 0) {
        return { handled: true, say: `${said} ${spokenClose(order)}`, toolCalls: calls, kind: "specials" };
      }
    }
    if (atNameStage(state)) {
      return { handled: true, say: `${said} What's the name for the order?`, toolCalls: calls, kind: "specials" };
    }
    if (state.draftOrderId) {
      return { handled: true, say: `${said} ${await anythingElse(ctx, state)}`, toolCalls: calls, kind: "specials" };
    }
    return { handled: true, say: `${said} What can I get you?`, toolCalls: calls, kind: "specials" };
  }

  // ---- returning caller answering the proactive "Same as last time?" greeting.
  // Yes -> clone their last order at current prices and read back the total to
  // confirm. A bare "no" -> order fresh. Anything else (they just start ordering)
  // clears the offer and falls through to normal item handling.
  if (!opts.probe && state.repeatOffered && !state.draftOrderId) {
    const norm = normalise(text);
    const isRepeatYes =
      /\b(same|usual)\b/.test(norm) ||
      (isYes(text) && norm.split(" ").filter(Boolean).length <= 3);
    if (isRepeatYes) {
      state.repeatOffered = false;
      const r = await run("repeat_last_order", {});
      if (r.error) return NOT_HANDLED; // no candidate / failed -> LLM sorts it out
      // Some of their usual items are now unavailable / were specials that
      // ended — the LLM must TELL them what changed before closing, instead of
      // reading a silently-shortened total (audit 2026-09-24).
      if (Array.isArray(r.changes) && r.changes.length > 0) return NOT_HANDLED;
      const order = state.draftOrderId ? await getOrderWithItems(ctx.db, state.draftOrderId) : null;
      if (!order || order.items.length === 0) return NOT_HANDLED;
      if (!realName(order)) {
        return { handled: true, say: "Can I get a name for the order?", toolCalls: calls, kind: "ask_name" };
      }
      state.summarySeq = state.mutationSeq;
      return { handled: true, say: spokenClose(order), toolCalls: calls, kind: "repeat_close" };
    }
    state.repeatOffered = false;
    // Declining the "same as last time?" offer to order fresh — "no", "no I'll
    // make a new order", "another order please" — should hand straight to
    // ordering, not take a ~2s LLM turn (live AU calls MB1135-7). But if they
    // named an item/drink in the same breath ("no, a chicken kebab"), fall
    // through so it's actually added — never swallow the order.
    const norm2 = normalise(text);
    const afterDecline = norm2.replace(/^(?:no|nah|nope)[,\s]+/, "").trim();
    const declined = /^(?:no|nah|nope)\b/.test(norm2);
    const wantsFreshWords =
      /\b(new order|another order|new one|another one|start over|start again|order again|make (?:a |an )?(?:new |another )?order|place (?:a |an )?(?:new |another )?order)\b/.test(
        norm2,
      );
    const ORDER_ISH =
      /\b(kebab|meatbox|meat box|box|chips|rice|kofta|burger|chicken|lamb|mixed|falafel|gozleme|fish|charcoal|coke|fanta|sprite|solo|lemonade|water|juice|drink|dip|hummus|wrap|roll|combo|meal|salad|sauce|garlic|halloumi|cheese)\b/;
    const handoff =
      isFinished(text) || wantsFreshWords || (declined && !ORDER_ISH.test(afterDecline));
    if (handoff) {
      return { handled: true, say: "No worries — what can I get you?", toolCalls: calls, kind: "repeat_declined" };
    }
    // else: they started ordering directly — fall through to normal handling.
  }

  // A bare greeting back at the start ("hey", "hi there") — answer instantly
  // like a person would, instead of a ~2s LLM pleasantry. Committed-transcript
  // only (never a probe): a partial "hey" could be the front of "hey, can I
  // grab two meatboxes" and we must not answer the greeting and drop the order.
  if (!opts.probe && atGreetingStage(state) && !state.draftOrderId && isGreetingOnly(text)) {
    return { handled: true, say: GREETING_ACK, toolCalls: calls, kind: "greeting_ack" };
  }

  // ---- caller answers a pending item-family clarify ("a kebab" -> we asked
  // which -> "falafel"): resolve to the specific item and add it, no LLM.
  if (!opts.probe && state.pendingFamily && !atConfirmStage(state) && !atNameStage(state)) {
    const family = state.pendingFamily;
    const target = resolveFamilyAnswer(text, family);
    if (target) {
      state.pendingFamily = null;
      if (!ctx.settings.acceptingOrders) return NOT_HANDLED;
      if (!state.draftOrderId) {
        const draft = await run("create_order_draft", { orderType: "takeaway" });
        if (draft.error) return NOT_HANDLED;
      }
      const result = await run("add_order_item", { menuItemName: target, quantity: family.quantity });
      if (result.itemSavedAsPending && typeof result.ask === "string") {
        return { handled: true, say: result.ask, toolCalls: calls, kind: "item_pending" };
      }
      if (!result.error) return { handled: true, say: await anythingElse(ctx, state), toolCalls: calls, kind: "item_added" };
      return NOT_HANDLED;
    }
    // Unresolved — drop the pending family and let the LLM handle it fresh.
    state.pendingFamily = null;
    return NOT_HANDLED;
  }

  // ---- the ASSISTANT (usually the LLM) asked a "which meat?" clarify naming a
  // family — "Chicken, lamb, or mixed meatbox?" — and the caller answers with a
  // bare meat. Resolve straight to "<meat> <family>" (Chicken Meatbox) instead
  // of the generic family clarify re-asking "burger, kebab, meatbox, or pizza?"
  // and looping (live AU NO_ORDER call, turns 6-7). Bare meat only: "chicken
  // kebab" (2 tokens) still routes to the normal item match.
  if (!opts.probe && !state.pendingItem && !atConfirmStage(state) && !atNameStage(state)) {
    const fam = familyFromMeatClarify(lastLine(state));
    const parsedMeat = fam ? parseItemUtterance(text) : null;
    const meat =
      parsedMeat && parsedMeat.itemTokens.length === 1 &&
      ["chicken", "lamb", "mixed"].includes(parsedMeat.itemTokens[0]!)
        ? parsedMeat.itemTokens[0]!
        : null;
    if (fam && meat) {
      if (!ctx.settings.acceptingOrders) return NOT_HANDLED;
      const items = await orderableItems(ctx);
      const m = matchMenuItem(`${meat} ${fam}`, items.map((i) => ({ name: i.name, aliases: i.aliases })));
      if (m) {
        if (!state.draftOrderId) {
          const draft = await run("create_order_draft", { orderType: "takeaway" });
          if (draft.error) return NOT_HANDLED;
        }
        const result = await run("add_order_item", { menuItemName: m.menuItemName, quantity: m.quantity });
        if (result.itemSavedAsPending && typeof result.ask === "string") {
          return { handled: true, say: result.ask, toolCalls: calls, kind: "item_pending" };
        }
        if (!result.error) return { handled: true, say: await anythingElse(ctx, state), toolCalls: calls, kind: "item_added" };
      }
    }
  }

  // A pending (incomplete) item means the order isn't settled — finishing
  // or confirming deterministically could silently DROP that item. The LLM
  // has the conversational context to resolve it.
  const hasPending = Boolean(state.pendingItem);

  // ---- final YES at read-back -> confirm + close + hang up.
  // A yes that ALSO tacks on an addition/change ("yeah, and a coke", "yes but
  // make it lamb") must NOT confirm — isYes() is true (the additive
  // conjunctions aren't negations) but confirming would drop the addition and
  // hang up (audit 2026-09-24). Hand those to the LLM to add, then re-confirm.
  if (atConfirmStage(state) && state.draftOrderId && !hasPending && isYes(text) && !carriesOrderChange(text)) {
    const result = await run("confirm_order", {});
    if (result.error) return NOT_HANDLED; // guard tripped -> let the LLM sort it out
    const eta = typeof result.readyEstimate === "string"
      ? result.readyEstimate.split(" (")[0]
      : null;
    // Warm but professional sign-off instead of a clipped "Done." — short, no lag.
    const tail = [eta ?? "", canText ? "I'll text it through" : ""].filter(Boolean).join(", ");
    const say = tail ? `Perfect — ${tail}.` : "Perfect, you're all set.";
    await run("end_call", { reason: "done" });
    return { handled: true, say, endCall: true, toolCalls: calls, kind: "confirm_yes" };
  }

  // ---- "anything else?" -> "nah" -> name (if needed) or read-back
  if (atAnythingElseStage(state) && state.draftOrderId && !hasPending && isFinished(text)) {
    const order = await getOrderWithItems(ctx.db, state.draftOrderId);
    if (!order || order.items.length === 0) return NOT_HANDLED;
    // Anything still missing a required option? Let the LLM ask properly.
    if ((await missingRequiredGroups(ctx, order)).length > 0) return NOT_HANDLED;
    if (!realName(order)) {
      return {
        handled: true,
        say: "Can I get a name for the order?",
        toolCalls: calls,
        kind: "ask_name",
      };
    }
    state.summarySeq = state.mutationSeq; // total stated = summary read
    return { handled: true, say: spokenClose(order), toolCalls: calls, kind: "close" };
  }

  // ---- name answer after our deterministic name question
  if (atNameStage(state) && state.draftOrderId) {
    const name = cleanName(text);
    if (name) {
      await run("set_order_details", { customerName: name });
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      // Never close an EMPTY order — a garbled call where the LLM asked the name
      // before any item was actually added would otherwise say "That's 0 dollars,
      // confirm?" (live call MB1113). Hand back to the LLM to sort the order out.
      if (!order || order.items.length === 0) return NOT_HANDLED;
      state.summarySeq = state.mutationSeq;
      state.nameReaskCount = 0; // captured cleanly — clear the streak
      return { handled: true, say: spokenClose(order), toolCalls: calls, kind: "name_close" };
    }
    // Not a name. A plain yes/no/finish or short noise ("yes" to "what name?")
    // -> re-ask INSTANTLY instead of a ~1s brain turn. Compound/content-bearing
    // answers still go to the LLM (it may need to act on them, e.g. add an item).
    const wc = normalise(text).split(" ").filter(Boolean).length;
    if (isYes(text) || isFinished(text) || wc <= 2) {
      // Cap the re-ask: a garbled line that keeps sending "J"/"J J" must not
      // loop forever — hand to the LLM, which can rephrase or accept a spelling.
      if ((state.nameReaskCount ?? 0) >= 2) return NOT_HANDLED;
      const firstNameReask = (state.nameReaskCount ?? 0) === 0;
      state.nameReaskCount = (state.nameReaskCount ?? 0) + 1;
      return {
        handled: true,
        // Apologise once; on a repeat just ask again (no double "sorry").
        say: firstNameReask
          ? "Sorry — can I get a name for the order?"
          : "Can I get a name for the order?",
        toolCalls: calls,
        kind: "name_reask",
      };
    }
    return NOT_HANDLED;
  }

  // ---- deterministic item ordering: a clear menu item at the greeting or
  // after "anything else?" is added without the LLM ("two chicken meatboxes").
  // Also whenever NO order has started yet (`!draftOrderId`) — a cleanly matched
  // item is always safe to add then, e.g. named right after the AI's own clarify
  // question ("Chicken or lamb?" -> "Chicken meatbox"), which otherwise took a
  // ~2s LLM turn. Skipped when probing a partial (could be a prefix).
  if (
    !opts.probe &&
    !hasPending &&
    (atGreetingStage(state) || atOpenPromptStage(state) || !state.draftOrderId)
  ) {
    // Soft drink named by flavour ("a coke", "can of fanta") FIRST — a generic
    // "coke" alias on the drink item would otherwise add the can and leave the
    // flavour pending, re-asking what the caller already said.
    const drink = await matchDrink(ctx, text);
    if (drink) {
      if (!ctx.settings.acceptingOrders) return NOT_HANDLED;
      if (!state.draftOrderId) {
        const draft = await run("create_order_draft", { orderType: "takeaway" });
        if (draft.error) return NOT_HANDLED;
      }
      const dr = await run("add_order_item", {
        menuItemName: drink.menuItemName,
        quantity: drink.quantity,
        modifierNames: [drink.flavourName],
      });
      if (!dr.error) return { handled: true, say: await anythingElse(ctx, state), toolCalls: calls, kind: "drink_added" };
      return NOT_HANDLED;
    }
    const items = await orderableItems(ctx);
    const match = matchMenuItem(
      text,
      items.map((i) => ({ name: i.name, aliases: i.aliases })),
    );
    if (match) {
      if (!ctx.settings.acceptingOrders) return NOT_HANDLED; // paused -> LLM apologises
      if (!state.draftOrderId) {
        const draft = await run("create_order_draft", { orderType: "takeaway" });
        if (draft.error) return NOT_HANDLED;
      }
      let result = await run("add_order_item", {
        menuItemName: match.menuItemName,
        quantity: match.quantity,
        ...(match.inlineOptions && match.inlineOptions.length > 0
          ? { modifierNames: match.inlineOptions }
          : {}),
      });
      // An inline size ("large") that isn't an option on THIS item (e.g. a
      // meatbox) errors before anything is inserted — add it plain instead of
      // falling to the LLM. On Chips it resolves to the Large size and sticks.
      // EXCEPT when the size word names a DISTINCT menu item ("Small Meatbox"):
      // silently adding the full-size item there is wrong (audit 2026-09-24 —
      // "small chicken meatbox" was becoming a $19.95 full Chicken Meatbox).
      // Hand those to the LLM, which picks the sized item + its meat choice.
      if (result.error && match.inlineOptions && match.inlineOptions.length > 0) {
        const sizeNamesAnItem = match.inlineOptions.some((sz) =>
          items.some((i) => new RegExp(`\\b${sz}\\b`, "i").test(i.name)),
        );
        if (sizeNamesAnItem) return NOT_HANDLED;
        result = await run("add_order_item", {
          menuItemName: match.menuItemName,
          quantity: match.quantity,
        });
      }
      // Missing a required option (base/sauce) -> executor stashed pending +
      // returned the exact question to ask.
      if (result.itemSavedAsPending && typeof result.ask === "string") {
        return { handled: true, say: result.ask, toolCalls: calls, kind: "item_pending" };
      }
      if (!result.error) {
        return { handled: true, say: await anythingElse(ctx, state), toolCalls: calls, kind: "item_added" };
      }
      return NOT_HANDLED; // add failed unexpectedly -> LLM
    }
    // ---- COMPOUND order: "two chicken meatboxes and a mixed meatbox", "a
    // chicken kebab and a coke". Runs after the single-item match (so "fish and
    // chips" adds as one item). Adds every resolved item; the first needing a
    // base is asked, the rest queue and drain as each base is answered.
    const compound = await tryCompoundOrder(ctx, state, text, run);
    if (compound) {
      const say = compound.say || (await anythingElse(ctx, state));
      return { handled: true, say, toolCalls: calls, kind: compound.kind };
    }
    // Generic item family with no variant ("a kebab", "a meatbox") -> ask which
    // one deterministically and stash it; the answer resolves next turn. Runs
    // after the single-item match so a specific item still adds directly.
    const family = matchItemFamily(text, items.map((i) => ({ name: i.name, aliases: i.aliases })));
    if (family) {
      if (!ctx.settings.acceptingOrders) return NOT_HANDLED;
      state.pendingFamily = {
        familyWord: family.familyWord,
        candidates: family.candidates,
        quantity: family.quantity,
      };
      return { handled: true, say: `${spokenList(family.variants)}?`, toolCalls: calls, kind: "item_clarify" };
    }
    // Just an intent to order, no item ("I'd like to place an order for
    // takeaway") -> hand off to ordering instantly, like a person would.
    if (atGreetingStage(state) && isOrderIntentOnly(text)) {
      return { handled: true, say: GREETING_ACK, toolCalls: calls, kind: "intent_ack" };
    }
    // No clean single-item match at the greeting -> if it's an overlap or
    // unintelligible, ask them to repeat; otherwise the LLM understands it.
    if (atGreetingStage(state)) return garbledReask(state, wasBarge, calls) ?? NOT_HANDLED;
  }

  // ---- deterministic item swap: "make one of them a lamb one" -> reduce the
  // source line by one and add the target variant carrying the SAME options.
  // Skipped when probing (mutates the order).
  if (!opts.probe && !hasPending && state.draftOrderId && !atConfirmStage(state) && !atNameStage(state)) {
    const m = SWAP_RE.exec(normalise(text));
    if (m && m[1]) {
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (order && order.status === "draft" && order.items.length > 0) {
        const names = (await orderableItems(ctx)).map((i) => i.name);
        // Every source line that yields a single distinct same-type target.
        const pairs = order.items
          .map((line) => {
            const target = line.menuItemId ? resolveSwapTarget(m[1]!, line.nameSnapshot, names) : null;
            return target ? { line, target } : null;
          })
          .filter((p): p is { line: (typeof order.items)[number]; target: string } => Boolean(p));
        if (pairs.length === 1) {
          const { line, target } = pairs[0]!;
          const modNames = line.modifiers.map((mm) => mm.nameSnapshot);
          // Reduce (or remove) the source line first.
          const cut =
            line.quantity > 1
              ? await run("update_order_item", { orderItemId: line.id, quantity: line.quantity - 1 })
              : await run("remove_order_item", { orderItemId: line.id });
          if (cut.error) return NOT_HANDLED;
          // Add the target variant, carrying the same options by name.
          const add = await run("add_order_item", {
            menuItemName: target,
            quantity: 1,
            modifierNames: modNames,
            removals: line.removals,
          });
          if (add.itemSavedAsPending && typeof add.ask === "string") {
            return { handled: true, say: add.ask, toolCalls: calls, kind: "swap_pending" };
          }
          if (add.error) {
            // The target add failed AFTER the source was already cut — restore
            // the source so we don't leave the order short with nothing added
            // (audit 2026-09-24), then let the LLM sort the swap out.
            await run("add_order_item", {
              menuItemName: line.nameSnapshot,
              quantity: 1,
              modifierNames: modNames,
              removals: line.removals,
            });
            return NOT_HANDLED;
          }
          return { handled: true, say: await anythingElseAfterChange(ctx, state), toolCalls: calls, kind: "item_swap" };
        }
      }
    }
  }

  // ---- deterministic OPTION change: "make it a fanta", "change it to rice" ->
  // replace one single-select option on the (single) matching line. Keeps the
  // AI out of a change it tends to fumble (duplicating + narrating a cleanup).
  if (!opts.probe && !hasPending && state.draftOrderId && !atConfirmStage(state) && !atNameStage(state)) {
    const cm = CHANGE_RE.exec(normalise(text));
    if (cm && cm[1]) {
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (order && order.status === "draft" && order.items.length > 0) {
        const targets: { line: (typeof order.items)[number]; groupOptIds: Set<string>; newId: string }[] = [];
        for (const line of order.items) {
          if (!line.menuItemId) continue;
          const groups = await getModifierGroups(ctx.db, line.menuItemId);
          for (const g of groups) {
            if (g.maxSelect !== 1) continue; // only single-select options are a "change"
            const optList = g.modifiers.filter((mm) => mm.isAvailable).map((mm) => ({ id: mm.id, name: mm.name }));
            const match = matchOptions(cm[1]!, optList);
            if (match && match.ids.length === 1) {
              targets.push({ line, groupOptIds: new Set(g.modifiers.map((mm) => mm.id)), newId: match.ids[0]! });
            }
          }
        }
        if (targets.length === 1) {
          const { line, groupOptIds, newId } = targets[0]!;
          // Keep every other group's options; replace just this group's.
          const keep = line.modifiers
            .map((mm) => mm.modifierId)
            .filter((id): id is string => Boolean(id) && !groupOptIds.has(id!));
          const r = await run("update_order_item", {
            orderItemId: line.id,
            modifierIds: [...new Set([...keep, newId])],
          });
          if (!r.error) return { handled: true, say: await anythingElseAfterChange(ctx, state), toolCalls: calls, kind: "option_change" };
        }
      }
    }
  }

  // ---- deterministic QUANTITY change on the sole line: "make it two",
  // "actually three", "just one". One line only (else which line?).
  if (!opts.probe && !hasPending && state.draftOrderId && !atConfirmStage(state) && !atNameStage(state)) {
    const qm = QTY_CHANGE_RE.exec(normalise(text));
    if (qm && qm[1]) {
      const qty = QTY_WORDS[qm[1]!] ?? Number(qm[1]);
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (
        order && order.status === "draft" && order.items.length === 1 &&
        Number.isFinite(qty) && qty >= 1 && qty <= 20 && qty !== order.items[0]!.quantity
      ) {
        const r = await run("update_order_item", { orderItemId: order.items[0]!.id, quantity: qty });
        if (!r.error) return { handled: true, say: await anythingElseAfterChange(ctx, state), toolCalls: calls, kind: "qty_change" };
      }
    }
  }

  // ---- deterministic LINE removal: "cancel the coke", "scratch that",
  // "forget the kebab". Resolve the phrase to one line (or the most recent for
  // "that"/"it"/empty) and remove it. Only fires when it resolves to a real
  // line — otherwise (e.g. "remove the onion") it falls through to REMOVAL.
  if (!opts.probe && !hasPending && state.draftOrderId && !atConfirmStage(state) && !atNameStage(state)) {
    const rm = REMOVE_ITEM_RE.exec(normalise(text));
    if (rm) {
      const phrase = (rm[1] ?? "").trim();
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (order && order.status === "draft" && order.items.length > 0) {
        let target: (typeof order.items)[number] | null = null;
        // "scrap the whole order", "cancel everything", "start again".
        const clearAll = /\b(whole|everything|order|lot|all|again|start over|over)\b/.test(phrase);
        const pointer = phrase === "" || /^(that|it|this|one|the last one|last one|last)$/.test(phrase);
        if (clearAll) {
          for (const line of order.items) await run("remove_order_item", { orderItemId: line.id });
          state.draftOrderId = null; // back to a clean slate — next item adds fresh
          state.pendingItem = null;
          return { handled: true, say: "No worries, I've cleared that. What else can I get you?", toolCalls: calls, kind: "order_cleared" };
        }
        if (pointer) {
          target = order.items[order.items.length - 1]!; // most recent line
        } else {
          const matches = order.items.filter((line) => lineMatchesPhrase(line, phrase));
          if (matches.length === 1) target = matches[0]!;
        }
        if (target) {
          const r = await run("remove_order_item", { orderItemId: target.id });
          if (!r.error) {
            const fresh = await getOrderWithItems(ctx.db, state.draftOrderId);
            const empty = !fresh || fresh.items.length === 0;
            if (empty) { state.draftOrderId = null; state.pendingItem = null; }
            return {
              handled: true,
              say: empty
                ? "No worries, I've cleared that. What else can I get you?"
                : await anythingElseAfterChange(ctx, state),
              toolCalls: calls,
              kind: empty ? "order_cleared" : "item_removed",
            };
          }
        }
      }
    }
  }

  // ---- deterministic INGREDIENT removal: "no onion", "without pickles",
  // "hold the tomato". Remove a matching selected option, else record it in the
  // line's removals. Single line, or the one line the ingredient sits on.
  if (!opts.probe && !hasPending && state.draftOrderId && !atConfirmStage(state) && !atNameStage(state)) {
    const em = REMOVAL_RE.exec(normalise(text));
    if (em && em[1] && !isFinished(text) && !isYes(text)) {
      const ingr = normalise(em[1]).trim();
      const toks = ingr.split(" ").filter(Boolean);
      // Reassurances a caller tacks onto "no" that are NOT ingredient removals
      // ("no rush", "no worries", "no drama") — without this, on a single-line
      // order the fallback recorded a spurious "No rush" removal (audit 2026-09-24).
      const notIngredient = /\b(make|change|swap|turn|add|another|instead|order|more|worries|worry|problem|idea|thanks|thank|rush|hurry|drama|dramas|stress|biggie|probs|rushing)\b/;
      if (
        toks.length >= 1 && toks.length <= 2 && !notIngredient.test(ingr) &&
        QTY_WORDS[toks[0]!] === undefined
      ) {
        const order = await getOrderWithItems(ctx.db, state.draftOrderId);
        if (order && order.status === "draft" && order.items.length > 0) {
          const ingrSet = new Set(toks.map(singular));
          const hits = (line: (typeof order.items)[number]) => {
            const modHit = line.modifiers.some(
              (m) => m.modifierId && [...ingrSet].every((w) => contentTokens(m.nameSnapshot).map(singular).includes(w)),
            );
            return modHit || order.items.length === 1;
          };
          const candidates = order.items.filter(hits);
          const target = candidates.length === 1 ? candidates[0]! : null;
          if (target) {
            // Selected option matching the ingredient? Remove that option.
            const optToDrop = target.modifiers.find(
              (m) => m.modifierId && [...ingrSet].every((w) => contentTokens(m.nameSnapshot).map(singular).includes(w)),
            );
            if (optToDrop?.modifierId) {
              const keep = target.modifiers
                .map((m) => m.modifierId)
                .filter((id): id is string => Boolean(id) && id !== optToDrop.modifierId);
              const r = await run("update_order_item", { orderItemId: target.id, modifierIds: keep });
              if (!r.error) return { handled: true, say: await anythingElseAfterChange(ctx, state), toolCalls: calls, kind: "modifier_removed" };
            } else {
              // Not a selected option — record it as an ingredient removal.
              const merged = [...new Set([...target.removals.map(normalise), ingr])];
              const r = await run("update_order_item", { orderItemId: target.id, removals: merged });
              if (!r.error) return { handled: true, say: await anythingElseAfterChange(ctx, state), toolCalls: calls, kind: "removal" };
            }
          }
        }
      }
    }
  }

  // ---- caller volunteers a name at "anything else?" ("it's Kevin", "under
  // Sam") instead of saying "no" first: finish + set name + total-only close,
  // all deterministic. Requires an explicit name lead-in so a garbled item
  // word can't be mistaken for a name; a bare word stays with the LLM.
  const leadIn = NAME_LEADIN_RE.exec(text.trim());
  if (leadIn && atAnythingElseStage(state) && state.draftOrderId && !hasPending && !isYes(text)) {
    const captured = normalise(leadIn[1]!);
    const capTokens = captured.split(" ").filter(Boolean);
    const isName =
      capTokens.length >= 1 &&
      capTokens.length <= 2 &&
      capTokens.every((t) => !NON_NAME_WORDS.has(t) && QTY_WORDS[t] === undefined);
    const name = isName ? cleanName(leadIn[1]!) : null;
    if (name) {
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (
        order &&
        order.status === "draft" &&
        order.items.length > 0 &&
        !order.customerName.trim() &&
        (await missingRequiredGroups(ctx, order)).length === 0 &&
        (await optionalGroupTargets(ctx, order, text)).length === 0
      ) {
        await run("set_order_details", { customerName: name });
        const fresh = await getOrderWithItems(ctx.db, state.draftOrderId);
        if (fresh) {
          state.summarySeq = state.mutationSeq;
          return { handled: true, say: spokenClose(fresh), toolCalls: calls, kind: "name_close" };
        }
      }
    }
  }

  // ---- caller asks what the choices are ("what salads do you have?") or
  // wants them all ("all of them") in answer to an option question (ours OR an
  // LLM "which salads?"). List or select-all deterministically instead of a
  // ~2s LLM turn. Runs BEFORE the pending/option handlers so the question
  // isn't mis-read as an answer.
  if (
    (state.draftOrderId || state.pendingItem) &&
    !atConfirmStage(state) &&
    !atNameStage(state)
  ) {
    const wantsList = isOptionsQuery(text);
    const wantsAll = isSelectAll(text);
    if (wantsList || wantsAll) {
      const order = state.draftOrderId
        ? await getOrderWithItems(ctx.db, state.draftOrderId)
        : null;
      // The group being answered (from context), or — when the caller
      // proactively names one ("what SAUCES do you have", "all the SALADS")
      // at "anything else?" — the group their own words point to.
      let asked = await currentAskedGroups(ctx, state, order);
      if (asked.length === 0 && order) asked = await groupFromUtterance(ctx, order, text);
      if (asked.length > 0) {
        const g = asked[0]!;
        if (wantsList) {
          return {
            handled: true,
            say: listOptions(g.options.map((o) => o.name)),
            toolCalls: calls,
            kind: "options_listed",
          };
        }
        // wantsAll: fill every option if the group allows taking them all.
        if (g.maxSelect > 1 && order) {
          const applicable = asked.filter((a) => a.orderItemId);
          if (g.options.length <= g.maxSelect && applicable.length > 0) {
            for (const target of applicable) {
              const merged = [
                ...new Set([...target.chosenIds, ...target.options.map((o) => o.id)]),
              ];
              const r = await run("update_order_item", {
                orderItemId: target.orderItemId,
                modifierIds: merged,
              });
              if (r.error) return NOT_HANDLED;
            }
            const fresh = await getOrderWithItems(ctx.db, state.draftOrderId!);
            const stillMissing = fresh ? await missingRequiredGroups(ctx, fresh) : [];
            const say =
              stillMissing.length > 0 ? `${stillMissing[0]!.groupName}?` : await anythingElse(ctx, state);
            return { handled: true, say, toolCalls: calls, kind: "select_all" };
          }
          // More options than the cap (6 sauces, pick 3) -> list them and ask.
          return {
            handled: true,
            say: `You can pick up to ${numWord(g.maxSelect)}. Which would you like — ${spokenList(g.options.map((o) => o.name))}?`,
            toolCalls: calls,
            kind: "over_max",
          };
        }
      }
    }
  }

  // ---- completing a pending item whose required option was missing
  // ("Chicken meatbox" -> add failed on Base -> "chips" completes the add)
  if (state.pendingItem && state.draftOrderId && !atConfirmStage(state)) {
    const pending = state.pendingItem;
    const groups = await getModifierGroups(ctx.db, pending.menuItemId);
    const chosenGroupIds = new Set(
      groups
        .flatMap((g) => g.modifiers.map((m) => ({ g, id: m.id })))
        .filter((x) => pending.modifierIds.includes(x.id))
        .map((x) => x.g.id),
    );
    const missingGroups = groups.filter((g) => {
      const minimum = g.required ? Math.max(1, g.minSelect) : g.minSelect;
      return minimum > 0 && !chosenGroupIds.has(g.id);
    });
    if (missingGroups.length > 0) {
      const target = missingGroups[0]!;
      const match = matchOptions(text, target.modifiers.filter((m) => m.isAvailable));
      if (match && match.ids.length <= target.maxSelect) {
        const result = await run("add_order_item", {
          menuItemId: pending.menuItemId,
          quantity: pending.quantity,
          modifierIds: [...pending.modifierIds, ...match.ids],
          removals: pending.removals,
          ...(pending.specialInstructions
            ? { specialInstructions: pending.specialInstructions }
            : {}),
        });
        if (!result.error) {
          // Added (executor cleared pendingItem). If a compound order queued
          // more items behind this one, add the next (it may need its own base).
          state.optionReaskCount = 0;
          const next = await drainPendingQueue(ctx, state, run);
          return {
            handled: true,
            say: next ? next.say : await anythingElse(ctx, state),
            toolCalls: calls,
            kind: next ? next.kind : "pending_fill",
          };
        }
        // Another required group still missing: the executor re-stashed the
        // pending item WITH the options we just merged — ask the next one.
        if (result.code === "MODIFIER_REQUIRED" && state.pendingItem) {
          const nowChosen = new Set(state.pendingItem.modifierIds);
          const next = groups.find((g) => {
            const minimum = g.required ? Math.max(1, g.minSelect) : g.minSelect;
            return minimum > 0 && !g.modifiers.some((m) => nowChosen.has(m.id));
          });
          if (next) {
            return {
              handled: true,
              say: groupQuestion(next.name, next.modifiers.filter((m) => m.isAvailable).map((m) => m.name)),
              toolCalls: calls,
              kind: "pending_next_question",
            };
          }
        }
        return NOT_HANDLED;
      }
      // No option matched. If it's just an unclear/garbled attempt at THIS
      // required question, re-ask it instantly (no ~2s LLM turn); cap the
      // instant re-asks so a stuck caller still reaches the LLM.
      if (isUnclearOptionAnswer(text) && (state.optionReaskCount ?? 0) < 2) {
        const lead = reaskLead(state.optionReaskCount ?? 0);
        state.optionReaskCount = (state.optionReaskCount ?? 0) + 1;
        return {
          handled: true,
          say: `${lead}${groupQuestion(
            target.name,
            target.modifiers.filter((m) => m.isAvailable).map((m) => m.name),
          )}`,
          toolCalls: calls,
          kind: "option_reask",
        };
      }
    }
    return NOT_HANDLED; // pending item but unclear answer -> LLM
  }

  // ---- bare option answers ("large", "garlic", "garlic and chilli on both")
  if (state.draftOrderId && !atConfirmStage(state)) {
    const order = await getOrderWithItems(ctx.db, state.draftOrderId);
    if (!order || order.status !== "draft" || order.items.length === 0) return NOT_HANDLED;
    const missing = await missingRequiredGroups(ctx, order);

    let targets: MissingGroup[];
    let kind: string;
    if (missing.length > 0) {
      // Answering the pending required-option question.
      const groupName = missing[0]!.groupName;
      targets = missing.filter((m) => m.groupName === groupName);
      kind = "option_fill";
    } else {
      // Nothing required is missing — a clean option answer here is the
      // caller ADDING options ("garlic on both"). Find the one optional
      // group whose options cover the utterance across all items.
      targets = await optionalGroupTargets(ctx, order, text, lastLine(state));
      kind = "optional_fill";
      if (targets.length === 0) return NOT_HANDLED;
    }

    const match = matchOptions(text, targets[0]!.options);
    if (!match) {
      // Unclear answer to a still-missing required question -> re-ask it
      // instantly rather than a ~2s LLM turn (garbled line). Capped.
      if (missing.length > 0 && isUnclearOptionAnswer(text) && (state.optionReaskCount ?? 0) < 2) {
        const lead = reaskLead(state.optionReaskCount ?? 0);
        state.optionReaskCount = (state.optionReaskCount ?? 0) + 1;
        return {
          handled: true,
          say: `${lead}${groupQuestion(targets[0]!.groupName, targets[0]!.options.map((o) => o.name))}`,
          toolCalls: calls,
          kind: "option_reask",
        };
      }
      return NOT_HANDLED;
    }
    if (match.ids.length > targets[0]!.maxSelect) return NOT_HANDLED;
    // Default to ALL matching items: a bare "lettuce and tomato" after
    // "salad on both" means both — and the read-back surfaces it anyway.
    const applyTo = targets;
    const nameById = new Map(targets[0]!.options.map((o) => [o.id, normalise(o.name)]));
    for (const target of applyTo) {
      // Same group on another item may have different modifier ids — remap by name.
      const ids =
        target === targets[0]
          ? match.ids
          : match.ids
              .map((id) => target.options.find((o) => normalise(o.name) === nameById.get(id))?.id)
              .filter((id): id is string => Boolean(id));
      if (ids.length === 0) continue;
      const merged = [...new Set([...target.chosenIds, ...ids])];
      if (merged.length > /* whole line cap */ 12) return NOT_HANDLED;
      const result = await run("update_order_item", {
        orderItemId: target.orderItemId,
        modifierIds: merged,
      });
      if (result.error) return NOT_HANDLED; // validation said no -> LLM takes over
    }
    // A required option was filled — clear the instant-re-ask counter.
    state.optionReaskCount = 0;
    // What's next? The following missing required group, or "Anything else?"
    const fresh = await getOrderWithItems(ctx.db, state.draftOrderId);
    const stillMissing = fresh ? await missingRequiredGroups(ctx, fresh) : [];
    const say = stillMissing.length > 0 ? `${stillMissing[0]!.groupName}?` : await anythingElse(ctx, state);
    return { handled: true, say, toolCalls: calls, kind };
  }

  // Kevin's rule: an overlapped (talked-over) or unintelligible utterance the
  // fast path couldn't place -> say sorry and ask them to repeat, instantly,
  // rather than guessing or lagging on the AI. Not at the confirm/name stages
  // (their own re-asks cover those).
  if (!opts.probe && !atConfirmStage(state) && !atNameStage(state)) {
    const g = garbledReask(state, wasBarge, calls);
    if (g) return g;
  }

  return NOT_HANDLED;
}

/**
 * For an "add options" utterance with nothing required missing: the single
 * optional group (by name, across items) whose options cover the utterance.
 * Groups with maxSelect 1 that are already filled are skipped (that's a
 * CHANGE, which the LLM should handle).
 */
async function optionalGroupTargets(
  ctx: AgentContext,
  order: OrderWithItems,
  utterance: string,
  lastAssistantLine = "",
): Promise<MissingGroup[]> {
  const byName = new Map<string, MissingGroup[]>();
  for (const item of order.items) {
    if (!item.menuItemId) continue;
    const groups = await getModifierGroups(ctx.db, item.menuItemId);
    for (const group of groups) {
      const chosenInGroup = item.modifiers.filter(
        (m) => m.groupNameSnapshot === group.name,
      ).length;
      if (chosenInGroup >= group.maxSelect) continue; // full — a change, not an add
      const entry: MissingGroup = {
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        groupId: group.id,
        groupName: group.name,
        maxSelect: group.maxSelect,
        options: group.modifiers
          .filter((m) => m.isAvailable)
          .map((m) => ({ id: m.id, name: m.name })),
        chosenIds: item.modifiers.filter((m) => m.modifierId).map((m) => m.modifierId!),
      };
      if (!byName.has(group.name)) byName.set(group.name, []);
      byName.get(group.name)!.push(entry);
    }
  }
  const covering: { entries: MissingGroup[]; strong: boolean }[] = [];
  for (const entries of byName.values()) {
    const match = matchOptions(utterance, entries[0]!.options);
    if (!match) continue;
    // Strong claim: every matched option is hit by exact phrase or by the
    // option's FIRST content word ("garlic" -> "Garlic sauce" is strong;
    // "garlic" -> "Extra garlic dip" is weak).
    const strong = match.ids.every((id) => {
      const opt = entries[0]!.options.find((o) => o.id === id)!;
      const words = contentTokens(opt.name);
      const utteranceTokens = new Set(contentTokens(utterance));
      return (
        words.length > 0 &&
        (utteranceTokens.has(words[0]!) ||
          contentTokens(utterance).join(" ") === words.join(" "))
      );
    });
    covering.push({ entries, strong });
  }
  const strongOnes = covering.filter((c) => c.strong);
  const pool = strongOnes.length > 0 ? strongOnes : covering;
  if (pool.length === 1) return pool[0]!.entries;
  // Ambiguous word claimed by more than one group ("tomato" = a salad AND
  // Tomato sauce): if the assistant JUST asked about one of them ("which
  // salads?"), the answer belongs to that group (MB1129).
  if (pool.length > 1 && lastAssistantLine) {
    const ll = normalise(lastAssistantLine);
    const byQuestion = pool.filter((c) => ll.includes(groupStem(c.entries[0]!.groupName)));
    if (byQuestion.length === 1) return byQuestion[0]!.entries;
  }
  return []; // still ambiguous -> LLM
}

/** A group's last name word with any trailing plural 's' dropped, for a
 * singular/plural utterance match ("Sauces" -> "sauce" -> \bsauces?\b). Uses a
 * plain 's' strip, NOT singular() (which turns "sauces" into "sauc"). */
function groupStem(groupName: string): string {
  return normalise(groupName).split(" ").pop()!.replace(/s$/, "");
}

/** Does a caller phrase ("the coke", "chicken kebab", "drink") name this order
 * line, for LINE removal? Matches on the item NAME — NOT on a food item's
 * ingredients, so "remove the onion" (an ingredient) does NOT match a kebab
 * that has onion and delete the whole kebab. A DRINK is the exception: it's
 * identified by its flavour ("the coke" = Soft Drink Can carrying Coke), so a
 * drink line also matches on its option words. */
function lineMatchesPhrase(
  line: { nameSnapshot: string; modifiers: { nameSnapshot: string }[] },
  phrase: string,
): boolean {
  const p = normalise(phrase)
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w))
    .map(singular);
  if (p.length === 0) return false;
  const nameTokens = new Set(normalise(line.nameSnapshot).split(" ").map(singular));
  if (p.every((w) => nameTokens.has(w))) return true;
  if (/drink/i.test(line.nameSnapshot)) {
    const modTokens = new Set(
      line.modifiers.flatMap((m) => normalise(m.nameSnapshot).split(" ").map(singular)),
    );
    if (p.every((w) => nameTokens.has(w) || modTokens.has(w))) return true;
  }
  return false;
}

/** A group's options spoken as a plain list: "lettuce, tomato, onion, tabouli,
 * or pickles" — the " sauce" suffix and "&" are dropped so it reads naturally. */
function spokenList(names: string[]): string {
  const spoken = names.map((n) =>
    n.replace(/\s+sauce$/i, "").replace(/\s*&\s*/g, " and ").toLowerCase(),
  );
  if (spoken.length === 0) return "";
  if (spoken.length === 1) return spoken[0]!;
  return `${spoken.slice(0, -1).join(", ")}, or ${spoken[spoken.length - 1]}`;
}

/** The list as a question: "lettuce, tomato, onion, tabouli, or pickles. Which
 * ones?" — spoken when the caller asks what a group's choices are. */
export function listOptions(names: string[]): string {
  const list = spokenList(names);
  if (!list) return "";
  return names.length === 1 ? `${list}. Which one?` : `${list}. Which ones?`;
}

/**
 * The option group the caller is currently being asked about — for answering
 * "what are the choices?" / "all of them". In priority: a pending item's first
 * missing required group; a required group missing on the placed order; else
 * the single optional group the assistant's last line referenced.
 */
async function currentAskedGroups(
  ctx: AgentContext,
  state: AgentState,
  order: OrderWithItems | null,
): Promise<MissingGroup[]> {
  if (state.pendingItem) {
    const groups = await getModifierGroups(ctx.db, state.pendingItem.menuItemId);
    const chosen = new Set(state.pendingItem.modifierIds);
    const chosenGroupIds = new Set(
      groups.filter((g) => g.modifiers.some((m) => chosen.has(m.id))).map((g) => g.id),
    );
    const miss = groups.find((g) => {
      const min = g.required ? Math.max(1, g.minSelect) : g.minSelect;
      return min > 0 && !chosenGroupIds.has(g.id);
    });
    if (!miss) return [];
    return [
      {
        orderItemId: "", // still pending — not a placed line, so list-only
        menuItemId: state.pendingItem.menuItemId,
        groupId: miss.id,
        groupName: miss.name,
        maxSelect: miss.maxSelect,
        options: miss.modifiers.filter((m) => m.isAvailable).map((m) => ({ id: m.id, name: m.name })),
        chosenIds: [...chosen],
      },
    ];
  }
  if (!order) return [];
  const missing = await missingRequiredGroups(ctx, order);
  if (missing.length > 0) {
    const gn = missing[0]!.groupName;
    return missing.filter((m) => m.groupName === gn);
  }
  return askedOptionalGroups(ctx, order, normalise(state.lastAssistantText));
}

/** The one optional group the assistant's last line was asking about — matched
 * by the group's name or by two of its option words appearing in that line
 * ("Which salads do you want?" -> Salads). Ambiguous or none -> []. */
async function askedOptionalGroups(
  ctx: AgentContext,
  order: OrderWithItems,
  lastLine: string,
): Promise<MissingGroup[]> {
  const byName = new Map<string, MissingGroup[]>();
  for (const item of order.items) {
    if (!item.menuItemId) continue;
    const groups = await getModifierGroups(ctx.db, item.menuItemId);
    for (const group of groups) {
      const chosenInGroup = item.modifiers.filter(
        (m) => m.groupNameSnapshot === group.name,
      ).length;
      if (chosenInGroup >= group.maxSelect) continue;
      const entry: MissingGroup = {
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        groupId: group.id,
        groupName: group.name,
        maxSelect: group.maxSelect,
        options: group.modifiers.filter((m) => m.isAvailable).map((m) => ({ id: m.id, name: m.name })),
        chosenIds: item.modifiers.filter((m) => m.modifierId).map((m) => m.modifierId!),
      };
      if (!byName.has(group.name)) byName.set(group.name, []);
      byName.get(group.name)!.push(entry);
    }
  }
  const referenced = (entries: MissingGroup[]): boolean => {
    const g = entries[0]!;
    const gname = groupStem(g.groupName);
    if (gname && new RegExp(`\\b${gname}s?\\b`).test(lastLine)) return true;
    const firsts = g.options
      .map((o) => contentTokens(o.name)[0])
      .filter((w): w is string => Boolean(w));
    const inLine = firsts.filter((w) => new RegExp(`\\b${w}\\b`).test(lastLine)).length;
    return inLine >= 2;
  };
  const matches = [...byName.values()].filter(referenced);
  return matches.length === 1 ? matches[0]! : [];
}

/** The group the caller NAMED in their own words ("what sauces do you have",
 * "all the salads") — used at "anything else?" when there's no pending
 * question. The group name (singular) must appear in the utterance, and it
 * must not already be full. Exactly one such group, or []. */
async function groupFromUtterance(
  ctx: AgentContext,
  order: OrderWithItems,
  utterance: string,
): Promise<MissingGroup[]> {
  const u = normalise(utterance);
  const byName = new Map<string, MissingGroup[]>();
  for (const item of order.items) {
    if (!item.menuItemId) continue;
    const groups = await getModifierGroups(ctx.db, item.menuItemId);
    for (const group of groups) {
      const chosenInGroup = item.modifiers.filter(
        (m) => m.groupNameSnapshot === group.name,
      ).length;
      if (chosenInGroup >= group.maxSelect) continue;
      const gname = groupStem(group.name);
      if (!gname || !new RegExp(`\\b${gname}s?\\b`).test(u)) continue;
      const entry: MissingGroup = {
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        groupId: group.id,
        groupName: group.name,
        maxSelect: group.maxSelect,
        options: group.modifiers.filter((m) => m.isAvailable).map((m) => ({ id: m.id, name: m.name })),
        chosenIds: item.modifiers.filter((m) => m.modifierId).map((m) => m.modifierId!),
      };
      if (!byName.has(group.name)) byName.set(group.name, []);
      byName.get(group.name)!.push(entry);
    }
  }
  return byName.size === 1 ? [...byName.values()][0]! : [];
}

