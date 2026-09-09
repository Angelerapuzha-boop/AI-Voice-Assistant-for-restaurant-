import { describe, expect, it } from "vitest";
import { formatCents, speakCents } from "../src/money";
import { priceLine, priceOrder } from "../src/domain/pricing";

describe("money", () => {
  it("formats cents", () => {
    expect(formatCents(2495)).toBe("$24.95");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(100000)).toBe("$1000.00");
    expect(formatCents(5)).toBe("$0.05");
  });

  it("rejects non-integer money", () => {
    expect(() => formatCents(24.95)).toThrow();
  });

  it("speaks prices", () => {
    expect(speakCents(2495)).toBe("24 dollars 95");
    expect(speakCents(2000)).toBe("20 dollars");
  });
});

describe("priceLine", () => {
  it("multiplies unit + modifiers by quantity", () => {
    const line = priceLine({
      unitPriceCents: 1995,
      quantity: 2,
      modifiers: [{ priceCents: 500 }, { priceCents: 0 }],
    });
    expect(line.unitTotalCents).toBe(2495);
    expect(line.lineTotalCents).toBe(4990);
  });

  it("rejects bad quantities", () => {
    expect(() => priceLine({ unitPriceCents: 100, quantity: 0, modifiers: [] })).toThrow();
    expect(() => priceLine({ unitPriceCents: 100, quantity: 1.5, modifiers: [] })).toThrow();
  });

  it("rejects float cents", () => {
    expect(() => priceLine({ unitPriceCents: 19.95, quantity: 1, modifiers: [] })).toThrow();
  });
});

describe("priceOrder", () => {
  it("sums lines and applies discount", () => {
    const totals = priceOrder(
      [
        { unitPriceCents: 1995, quantity: 2, modifiers: [{ priceCents: 500 }] },
        { unitPriceCents: 1395, quantity: 1, modifiers: [] },
      ],
      500,
    );
    expect(totals.subtotalCents).toBe(2 * 2495 + 1395);
    expect(totals.totalCents).toBe(totals.subtotalCents - 500);
  });

  it("caps discount at subtotal", () => {
    const totals = priceOrder([{ unitPriceCents: 100, quantity: 1, modifiers: [] }], 500);
    expect(totals.totalCents).toBe(0);
  });
});
