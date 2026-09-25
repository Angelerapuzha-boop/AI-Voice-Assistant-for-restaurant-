/**
 * Caller-speech classifiers shared by the deterministic fast paths and the
 * tool executor's hard guards. Conservative by design: anything not
 * clearly recognised returns false and the LLM (or a re-ask) handles it.
 */

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripPoliteness(text: string): string {
  return text
    .replace(/\b(please|mate|thanks|thank you|cheers|ta)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const YES_PHRASES = new Set([
  "yes", "yep", "yeah", "yup", "correct", "that's right", "thats right",
  "that's correct", "thats correct", "all good", "sounds good", "sweet",
  "sure", "go ahead", "confirm", "yes please", "yeah that's right",
  "yep that's right", "yeah correct", "yep correct", "righto", "right",
  "yes that's right", "yes correct", "perfect", "spot on", "done", "good",
  "confirm it", "yes confirm", "yep confirm", "lock it in", "go for it",
  "do it", "yes do it", "that's the one", "thats the one", "all correct",
  "yeah all good", "yep all good", "yes all good",
  "good to go", "all good to go", "ready to go", "send it", "send it through",
  "that works", "sounds right", "looks good",
  "happy with that", "that's fine", "thats fine", "confirmed",
  "ok", "okay", "okey", "okey dokey", "alright", "all right", "ok cool",
  "yeah ok", "yep ok", "ok great", "cool",
  // Aussie "proceed" phrasings — a confirm, never a name ("yeah go on then"
  // strips the ack to "go on then"). Keeps these out of cleanName as names.
  "go on", "go on then", "go on mate", "on you go", "on ya go", "away you go",
  // Casual Aussie confirmations. "no worries" is listed BEFORE the NEGATION
  // check runs (YES_PHRASES is tested first in isYes), so its "no" is safe here.
  "beauty", "too easy", "no worries", "sweet as", "sweet as mate", "bewdy",
  "you beauty", "deadset", "for sure",
  // more natural confirmations callers use (view-probe 2026-09-24)
  "book it", "book it in", "book that in", "bang on", "you got it", "please do",
  "lock her in", "lock it", "that'll be right", "thatll be right", "that is right",
  "yes book it", "yep book it", "nailed it", "do", "do that",
]);

const FINISH_PHRASES = new Set([
  "no", "nah", "nope", "nothing", "nothing else", "no that's it",
  "that's it", "thats it", "that's all", "thats all", "that's the lot",
  "thats the lot", "that's a lot", "thats a lot", "that's me", "thats me", "all good", "that'll do",
  "that will do", "that's everything", "thats everything", "no that's all",
  "nah that's it", "nah thats it", "no thats it", "im good", "i'm good",
  "we're good", "were good", "that is it", "that is all",
  "that'll be it", "that will be it", "that's us", "thats us",
  "we're done", "were done", "i'm done", "im done", "that's it for me",
  "that's the lot thanks", "that'll be all", "that will be all",
  "its okay", "it's okay", "im okay", "i'm okay", "that's okay", "thats okay",
  "no im okay", "nah im okay", "im right", "i'm right", "no im right",
  "nah im right", "we're right", "were right", "no im good", "nah im good",
  "that's it thanks", "thats it thanks", "no thanks that's it", "all done",
  "that'll do me", "that will do me", "thatll do me", "that's me done",
  "thats me done", "that's me thanks", "thats me thanks", "i'm sweet",
  "im sweet", "we're sweet", "were sweet", "that's the go", "thats the go",
  // more natural "I'm finished" phrasings (view-probe 2026-09-24)
  "that's it for now", "thats it for now", "that's enough", "thats enough",
  "leave it there", "finished", "all set", "that's plenty", "thats plenty",
  "that's the lot thanks", "nah we're good", "that's us done", "thats us done",
  "that'll be it", "thatll be it", "that is it", "that is all", "no more",
  "no more thanks", "that's all for now", "thats all for now",
]);

// Confirm-style sentences that don't reduce to a set phrase ("yeah, we
// can confirm that", "yes, that order is correct" — live calls
// 2026-09-11). Any negation or change-request word wins.
const YES_PATTERN =
  /\b(?:(?:we|you|i) can confirm|confirm (?:that|it|the order)|lock (?:it|that) in)\b/;
const NEGATION =
  /\b(no|not|don't|dont|nah|wrong|change|hold|wait|actually|but|add|remove|another|instead|make|swap|cancel|repeat)\b/;
const YES_TOKEN = /^(yes|yep|yeah|yup|aye|correct|righto|sure|absolutely|definitely)$/;

export function isYes(text: string): boolean {
  const t = stripPoliteness(normalise(text));
  if (YES_PHRASES.has(t)) return true;
  if (NEGATION.test(t)) return false;
  // A sentence LED by a clear yes ("yes, that order is correct") is a yes
  // once negations are ruled out; stutters ("ye- yes") shift it one slot.
  if (t.split(" ").slice(0, 2).some((w) => YES_TOKEN.test(w))) return true;
  return YES_PATTERN.test(t);
}

export function isFinished(text: string): boolean {
  const t = stripPoliteness(normalise(text));
  if (FINISH_PHRASES.has(t)) return true;
  // A leading acknowledgement in front of a finish phrase — STT very often
  // prepends "nah"/"no" ("nah that's the lot", "no that's the lot").
  const lead = t.replace(/^(?:nah|no|nope|yeah|yep|yup|um|uh|ah|oh|so|well|ok|okay)\s+/, "");
  if (lead !== t && FINISH_PHRASES.has(lead)) return true;
  // A trailing "no"/"nah" or politeness tacked on ("it's okay no", "that's it
  // no", "im good thanks") — strip it and re-check.
  const trail = t.replace(/\s+(?:no|nah|nope|thanks|thank you|cheers|mate|please)$/, "");
  return trail !== t && FINISH_PHRASES.has(trail);
}

export const WAIT_REGEX =
  /\b(hang on|hold on|one sec|one second|give us a sec|give me a sec|just a sec|just a second|just a minute|one minute|hold up|wait)\b/;

// The caller asks WHAT the choices are, in answer to an option question
// ("what salads do you have?", "what are my options?", "which ones?") — a
// question, not an answer, so the option matcher would miss it and fall to a
// ~2s LLM turn. Recognise it and read the group's options back deterministically.
const OPTIONS_QUERY_RE =
  /\b(?:options?|choices?)\b|what (?:are|do|have|can|sauces?|salads?|sizes?|bases?|drinks?|flavou?rs?|dips?)|which (?:ones?|sauces?|salads?|of those|of them)|what else (?:do|have|can)|what are (?:they|my|the|your)|what have you got|what can i/;

export function isOptionsQuery(text: string): boolean {
  return OPTIONS_QUERY_RE.test(normalise(text));
}

// The caller is asking what's ON the menu ("what's the menu", "what do you
// have", "what are the options", "menu please") — answer with the item/category
// list, don't deflect with "what can I get you?" (live AU call NO_ORDER). Kept
// specific so a normal order ("can I get a chicken kebab") never matches.
export function isMenuRequest(text: string): boolean {
  const t = normalise(text);
  if (!t) return false;
  // "text/send/sms me the menu" wants the menu LINK (send_menu_link) — that's
  // the LLM's job, not a spoken read-out. Don't intercept those.
  if (/\b(text|send|sms|message|email|link|whatsapp)\b/.test(t)) return false;
  if (/\bmenu\b/.test(t)) return true; // menu, the menu, read the menu, what's the menu
  if (/\bwhat(?:'?s| is| are| do| does| have| ve| kinda?| type| sort)\b.*\b(have|got|sell|do|make|offer|option|options|choice|choices|available|serve|food|on)\b/.test(t)) return true;
  if (/\b(your|the|my)\s+(option|options|choice|choices)\b/.test(t)) return true;
  if (/^options?\b/.test(t)) return true;
  return false;
}

// "all of them", "everything", "the lot" — the caller wants EVERY option in
// the group being asked about. A single word ("all") is enough in context.
const SELECT_ALL_PHRASES = new Set([
  "all", "all of them", "all of the above", "all of it", "all of those",
  "all of these", "all of em", "all em", "everything", "the lot", "the works",
  "the whole lot", "one of each", "each of them", "every one", "everyone",
  "all please", "yes all", "all three", "all the three", "all the above",
  "all the sauces", "all sauces", "all the salads", "all salads",
  "everything on it", "everything please", "give me the lot", "the full lot",
]);

export function isSelectAll(text: string): boolean {
  const t = stripPoliteness(normalise(text)).replace(
    /^(?:yeah|yep|yup|nah|no|um|uh|ah|oh|so|well|ok|okay|just|can i get|i'll have|ill have|i want|give me|gimme|i'd like|id like)\s+/,
    "",
  );
  if (SELECT_ALL_PHRASES.has(t)) return true;
  // "all of the above/them/it ...", "the lot", "everything", "one of each"
  return /^(?:all of (?:the above|them|it|those|these)|the (?:whole )?lot|the works|everything|one of each)\b/.test(t);
}
