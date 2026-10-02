import { describe, expect, it } from "vitest";
import { endsMidThought, looksComplete } from "../src/media-stream-session";

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

// Fast-complete: reply sooner when the partial is CLEARLY a complete answer, but
// never on a bare number (which may still be "seven thirty" / an item still coming).
describe("looksComplete (reply sooner once the caller has clearly finished)", () => {
  it("is complete on a fully-formed answer", () => {
    for (const t of [
      "yes please", "no thanks", "that's all", "that's right", "go ahead", "lock it in", "cancel that",
      "tomorrow", "this friday", "next tuesday", "the 5th",
      "seven pm", "7 pm", "half past seven", "seven o'clock", "noon", "7:30",
      "four people", "party of four", "two of us", "a table for four",
      "0411 222 333", "it's 0412 345 678",
    ]) {
      expect(looksComplete(t), t).toBe(true);
    }
  });

  it("is NOT complete on a bare number or an unfinished phrase (keeps the safe wait)", () => {
    for (const t of [
      "seven", "four", "about", "um", "and", "make it", "i'll have the", "can i get a", "",
    ]) {
      expect(looksComplete(t), t).toBe(false);
    }
  });
});
