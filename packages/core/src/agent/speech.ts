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
]);

const FINISH_PHRASES = new Set([
  "no", "nah", "nope", "nothing", "nothing else", "no that's it",
  "that's it", "thats it", "that's all", "thats all", "that's the lot",
  "thats the lot", "that's me", "thats me", "all good", "that'll do",
  "that will do", "that's everything", "thats everything", "no that's all",
  "nah that's it", "nah thats it", "no thats it", "im good", "i'm good",
  "we're good", "were good", "that is it", "that is all",
]);

export function isYes(text: string): boolean {
  return YES_PHRASES.has(stripPoliteness(normalise(text)));
}

export function isFinished(text: string): boolean {
  return FINISH_PHRASES.has(stripPoliteness(normalise(text)));
}

export const WAIT_REGEX =
  /\b(hang on|hold on|one sec|one second|give us a sec|give me a sec|just a sec|just a second|just a minute|one minute|hold up|wait)\b/;
