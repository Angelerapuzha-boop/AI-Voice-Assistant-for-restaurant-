import { assertCents } from "../money";

/**
 * Server-side price calculation. The AI never does money arithmetic —
 * it selects items/modifiers and this module computes every total.
 */

export interface PriceableModifier {
  priceCents: number;
}

export interface PriceableItem {
  unitPriceCents: number;
  quantity: number;
  modifiers: PriceableModifier[];
}

export interface LineTotal {
  unitTotalCents: number; // unit price + per-unit modifier prices
  lineTotalCents: number; // unitTotal * quantity
}

export function priceLine(item: PriceableItem): LineTotal {
  assertCents(item.unitPriceCents, "unitPriceCents");
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    throw new Error(`quantity must be a positive integer, got ${item.quantity}`);
  }
  let modifierCents = 0;
  for (const mod of item.modifiers) {
    modifierCents += assertCents(mod.priceCents, "modifier priceCents");
  }
  const unitTotalCents = item.unitPriceCents + modifierCents;
  return { unitTotalCents, lineTotalCents: unitTotalCents * item.quantity };
}

export interface OrderTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

export function priceOrder(items: PriceableItem[], discountCents = 0): OrderTotals {
  assertCents(discountCents, "discountCents");
  let subtotal = 0;
  for (const item of items) {
    subtotal += priceLine(item).lineTotalCents;
  }
  const discount = Math.min(discountCents, subtotal);
  return { subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount };
}
