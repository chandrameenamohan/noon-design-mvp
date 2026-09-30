import { expect, test } from "vitest";
import { gapsBetween, paddingRing, type Rect } from "./spaces.ts";

// E10.4: hovering a gap or padding control shades THAT space on the canvas. The geometry is pure; Surface.tsx
// measures the boxes and draws what comes back.

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

test("the padding ring is the four strips between a box and its content, and nothing when there is no padding", () => {
  const ring = paddingRing(rect(0, 0, 100, 60), { top: 10, right: 20, bottom: 5, left: 8 });
  expect(ring).toEqual([
    rect(0, 0, 100, 10), // top, full width
    rect(0, 55, 100, 60), // bottom, full width
    rect(0, 10, 8, 55), // left, between the two
    rect(80, 10, 100, 55), // right, between the two
  ]);
  expect(paddingRing(rect(0, 0, 100, 60), { top: 0, right: 0, bottom: 0, left: 0 })).toEqual([]);
  // One side only: the empty strips are left out, the full-width strip stays.
  expect(paddingRing(rect(0, 0, 100, 60), { top: 0, right: 0, bottom: 12, left: 0 })).toEqual([rect(0, 48, 100, 60)]);
});

test("gaps are the spaces between consecutive children, along whichever axis they are laid out on", () => {
  // A row: three boxes side by side, 8 apart, of different heights: the gap spans the taller pair.
  expect(gapsBetween([rect(0, 0, 40, 20), rect(48, 0, 90, 30), rect(98, 4, 120, 20)])).toEqual([rect(40, 0, 48, 30), rect(90, 0, 98, 30)]);
  // A column: stacked, 12 apart.
  expect(gapsBetween([rect(0, 0, 100, 20), rect(0, 32, 80, 50)])).toEqual([rect(0, 20, 100, 32)]);
});

test("touching or overlapping children have no gap to shade; one child or none has nothing between", () => {
  expect(gapsBetween([rect(0, 0, 40, 20), rect(40, 0, 80, 20)])).toEqual([]);
  expect(gapsBetween([rect(0, 0, 40, 20), rect(30, 0, 80, 20)])).toEqual([]);
  expect(gapsBetween([rect(0, 0, 40, 20)])).toEqual([]);
  expect(gapsBetween([])).toEqual([]);
});
