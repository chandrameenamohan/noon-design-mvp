import { expect, test } from "vitest";
import { PRESENCE_COLOURS, colourOf, contrast } from "./colour.ts";

test("every presence colour reads as text on white AND as a background for white text (WCAG AA, 4.5:1)", () => {
  expect(PRESENCE_COLOURS.length).toBeGreaterThanOrEqual(6);
  for (const colour of PRESENCE_COLOURS) expect(contrast(colour, "#ffffff"), colour).toBeGreaterThanOrEqual(4.5);
});

test("the contrast ratio itself: black on white is 21:1, a colour on itself 1:1, and the order of the two does not matter", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#1d4ed8", "#1d4ed8")).toBe(1);
  expect(contrast("#1d4ed8", "#ffffff")).toBe(contrast("#ffffff", "#1d4ed8"));
});

test("a connection keeps its colour, and different connections usually differ", () => {
  expect(colourOf("p1")).toBe(colourOf("p1"));
  expect(new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(colourOf)).size).toBeGreaterThan(3);
});
