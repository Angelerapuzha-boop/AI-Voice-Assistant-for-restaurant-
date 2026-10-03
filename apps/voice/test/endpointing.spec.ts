import { describe, expect, it } from "vitest";
import { endsMidThought } from "../src/media-stream-session";

// Adaptive endpointing: a caller who trails off mid-thought/mid-change gets
// extra room to finish, so the assistant doesn't talk over their change of mind
// (Kevin 2026-09-24). A finished phrase must still endpoint fast (no added lag).
describe("endsMidThought (give space for a change of mind)", () => {
  it("holds when the caller is clearly not finished", () => {
    for (const t of [
      "make it a lamb and",
      "garlic and",
      "uh",
      "um...",
      "can I get a coke and a",
      "actually",
      "hmm",
      "I'll have the",
      "make it",
      "I'll get chicken or",
      // short question-openers — caller is mid-question, don't cut in
      "is there",
      "do you have",
      "what's",
      "how much",
      "any specials",
      "can I get",
      "have you got",
      // trailing prepositions / continuation words — clearly more coming
      // (Kevin 2026-09-25: "too fast, cut me off mid-sentence")
      "a couple of",
      "chuck some",
      "one for",
      "I'll just",
      "can I grab",
      "I want to",
      "something like",
      // trailing bare quantity — an item is still coming
      "I'll get two",
      "gimme three",
      "can I grab a couple",
    ]) {
      expect(endsMidThought(t), t).toBe(true);
    }
  });

  it("endpoints fast on a finished phrase (no extra wait)", () => {
    for (const t of [
      "chicken kebab",
      "chips and salad",
      "that's the lot",
      "garlic and chilli",
      "it's for Dave",
      "yeah that's it",
      "two lamb kebabs",
      "nah that's it",
      // complete quantity change / answer — endpoint fast, not a trailing number
      "make it two",
      "just two",
      "two",
      "",
    ]) {
      expect(endsMidThought(t), t).toBe(false);
    }
  });

  it("holds on a trailing time lead-in (a time is still coming)", () => {
    for (const t of ["tomorrow at", "book it around", "friday by", "about"]) {
      expect(endsMidThought(t), t).toBe(true);
    }
  });
});
