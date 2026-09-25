import { describe, expect, it } from "vitest";
import { buildKeyterms } from "../src/domain/menu";

describe("buildKeyterms (STT menu biasing)", () => {
  it("keeps distinctive words and short multiword phrases, drops filler", () => {
    const terms = buildKeyterms([
      // aliases first (the hard, curated spellings)
      "toum", "felafel", "kofta", "gozleme",
      // item names
      "Chicken Kebab", "Shish Taouk with Chips & Salad", "Lamb Meatbox",
      "Soft Drink Can",
    ]);
    const lower = terms.map((t) => t.toLowerCase());
    // distinctive vocabulary is present
    for (const w of ["toum", "felafel", "kofta", "gozleme", "kebab", "taouk", "meatbox"]) {
      expect(lower, w).toContain(w);
    }
    // A short multiword item name is kept whole ("Chicken Kebab", 13 chars)...
    expect(lower).toContain("chicken kebab");
    // ...but a >20-char name is never kept whole — only its distinctive words.
    expect(lower).not.toContain("shish taouk with chips & salad");
    expect(terms.every((t) => t.length <= 20)).toBe(true);
    // Decision words a caller must SAY are biased ("chips" mis-heard as "chicken").
    expect(lower).toContain("chips");
    // Pure filler / portion words never become keyterms.
    for (const w of ["with", "salad", "soft", "drink", "can"]) {
      expect(lower, w).not.toContain(w);
    }
  });

  it("biases the answer vocabulary — every salad & sauce, plus short 'bbq' (MB1129)", () => {
    const terms = buildKeyterms([
      "chips", "rice", "bbq",
      "Lettuce", "Tomato", "Onion", "Tabouli", "Pickles",
      "Garlic sauce", "Chilli sauce", "BBQ sauce", "Tahini sauce", "Sweet chilli sauce",
      "Chicken Kebab", "Lamb Meatbox",
    ]);
    const lower = terms.map((t) => t.toLowerCase());
    for (const w of ["bbq", "tabouli", "pickles", "lettuce", "tomato", "onion", "garlic", "chilli", "tahini"]) {
      expect(lower, w).toContain(w);
    }
  });

  it("enforces the API limits: <=20 chars each, <=50 terms, de-duplicated", () => {
    const many = Array.from({ length: 80 }, (_, i) => `term${i}`);
    const terms = buildKeyterms(["kebab", "Kebab", "KEBAB", ...many, "waytoolongtobeakeytermxx"]);
    expect(terms.length).toBeLessThanOrEqual(50);
    expect(terms.every((t) => t.length <= 20)).toBe(true);
    // case-insensitive de-dup: "kebab" appears once
    expect(terms.filter((t) => t.toLowerCase() === "kebab")).toHaveLength(1);
  });
});
