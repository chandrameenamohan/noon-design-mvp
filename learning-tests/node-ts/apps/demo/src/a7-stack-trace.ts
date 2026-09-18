// Assumption 7: stack trace line/column should match this SOURCE file
// exactly, even though type annotations get stripped to whitespace before
// execution (no source maps involved).
export function willThrow(x: number): number {
  const y: number = x + 1; if (y > 0) { throw new Error("boom"); }
  return y;
}

willThrow(1);
