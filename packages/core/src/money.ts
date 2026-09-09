/**
 * All money is integer cents (AUD). 2495 = $24.95.
 * Never use floating point for currency.
 */

export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`Money must be integer cents, got ${cents}`);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars}.${remainder.toString().padStart(2, "0")}`;
}

/** Spoken form for TTS: "$24.95" -> "24 dollars 95". Whole dollars stay simple. */
export function speakCents(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  if (remainder === 0) return `${dollars} dollars`;
  return `${dollars} dollars ${remainder}`;
}

export function assertCents(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents, got ${value}`);
  }
  return value;
}
