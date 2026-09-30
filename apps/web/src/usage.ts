/**
 * F31: numbers as the usage view and the AI panel write them, as TEXT. Fixed to en-US so a count reads the same in
 * every browser (and in the e2e test): "12,345" tokens, "$0.0123" (a run's estimate is often under a cent, so up to six
 * decimals, the database's own scale, and never fewer than two).
 */
const whole = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
export const tokens = (n: number): string => whole.format(n);
export const usd = (n: number): string => dollars.format(n);

/** How long to wait, in words, rounded UP (a person told "1 minute" who comes back at 61 seconds must not be refused again). */
export function waitWords(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${String(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
}
