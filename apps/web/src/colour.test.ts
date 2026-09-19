import { expect, test } from "vitest";
import { PRESENCE_COLOURS, colourOf } from "./colour.ts";

// WCAG 2.x relative luminance and contrast ratio, for "#rrggbb".
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
const contrastOnWhite = (hex: string): number => 1.05 / (luminance(hex) + 0.05);

test("every presence colour reads as text on white AND as a background for white text (WCAG AA, 4.5:1)", () => {
  expect(PRESENCE_COLOURS.length).toBeGreaterThanOrEqual(6);
  for (const colour of PRESENCE_COLOURS) expect(contrastOnWhite(colour), colour).toBeGreaterThanOrEqual(4.5);
});

test("a connection keeps its colour, and different connections usually differ", () => {
  expect(colourOf("p1")).toBe(colourOf("p1"));
  expect(new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(colourOf)).size).toBeGreaterThan(3);
});
