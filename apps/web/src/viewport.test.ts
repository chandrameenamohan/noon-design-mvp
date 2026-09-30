import { expect, test } from "vitest";
import { centreOn, clampZoom, fit, MAX_ZOOM, MIN_ZOOM, panBy, percent, toScreen, toWorld, wheelZoom, zoomAt, zoomStep, type Viewport } from "./viewport.ts";

// unit:viewport-math (E10.2)

const v: Viewport = { x: 100, y: 50, zoom: 2 };
const close = (a: { x: number; y: number }, b: { x: number; y: number }): void => { expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9); };

test("screen <-> world round-trips, and the world origin is drawn at the viewport's offset", () => {
  close(toScreen(v, { x: 0, y: 0 }), { x: 100, y: 50 });
  close(toWorld(v, { x: 100, y: 50 }), { x: 0, y: 0 });
  close(toScreen(v, { x: 10, y: -5 }), { x: 120, y: 40 });
  for (const p of [{ x: 0, y: 0 }, { x: 333, y: -12.5 }, { x: -1e6, y: 7 }]) {
    close(toWorld(v, toScreen(v, p)), p);
    close(toScreen(v, toWorld(v, p)), p);
  }
});

test("zooming about a point keeps the world point under it where it is", () => {
  const anchor = { x: 640, y: 360 };
  const before = toWorld(v, anchor);
  for (const zoom of [0.5, 1, 3, 3.999]) {
    const after = zoomAt(v, zoom, anchor);
    expect(after.zoom).toBe(zoom);
    close(toWorld(after, anchor), before);
  }
  // ...and a point elsewhere on the screen moves away from the anchor when zooming in.
  const zoomed = zoomAt(v, 4, anchor);
  const elsewhere = toWorld(v, { x: 700, y: 360 });
  expect(toScreen(zoomed, elsewhere).x - anchor.x).toBeCloseTo((700 - anchor.x) * 2, 9);
});

test("zoom is clamped to 10 %..400 % everywhere it is set", () => {
  expect(clampZoom(0)).toBe(MIN_ZOOM);
  expect(clampZoom(99)).toBe(MAX_ZOOM);
  expect(clampZoom(1)).toBe(1);
  expect(zoomAt(v, 0.001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM);
  expect(zoomAt(v, 1e9, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
  expect(zoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  expect(zoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  expect(wheelZoom(MAX_ZOOM, -1000)).toBe(MAX_ZOOM);
  expect(wheelZoom(MIN_ZOOM, 1000)).toBe(MIN_ZOOM);
});

test("+ then - lands back where it started; so does a wheel up then down", () => {
  expect(zoomStep(zoomStep(1, 1), -1)).toBeCloseTo(1, 12);
  expect(zoomStep(1, 1)).toBeGreaterThan(1);
  expect(zoomStep(1, -1)).toBeLessThan(1);
  expect(wheelZoom(wheelZoom(1, -40), 40)).toBeCloseTo(1, 12);
  expect(wheelZoom(1, -40)).toBeGreaterThan(1); // wheel up (negative deltaY) zooms in
  // One notch is bounded: never more than doubling or halving.
  expect(wheelZoom(1, -100000)).toBe(2);
  expect(wheelZoom(1, 100000)).toBe(0.5);
});

test("pan moves the offset only", () => {
  expect(panBy(v, 10, -20)).toEqual({ x: 110, y: 30, zoom: 2 });
});

test("fit shows the whole frame, centred, inside the padding, and never past the zoom limits", () => {
  // A 960x600 frame in a 1000x500 view with 32 px padding: the height decides (436 / 600).
  const fitted = fit({ width: 1000, height: 500 }, { width: 960, height: 600 });
  expect(fitted.zoom).toBeCloseTo(436 / 600, 9);
  close(toScreen(fitted, { x: 0, y: 0 }), { x: (1000 - 960 * fitted.zoom) / 2, y: 32 });
  close(toScreen(fitted, { x: 960, y: 600 }), { x: 1000 - (1000 - 960 * fitted.zoom) / 2, y: 468 });
  // A tiny frame in a huge view would zoom past 400 %: clamped, still centred.
  const small = fit({ width: 4000, height: 4000 }, { width: 10, height: 10 });
  expect(small.zoom).toBe(MAX_ZOOM);
  close(toScreen(small, { x: 5, y: 5 }), { x: 2000, y: 2000 });
  // A view smaller than the padding cannot go below 10 %.
  expect(fit({ width: 10, height: 10 }, { width: 960, height: 600 }).zoom).toBe(MIN_ZOOM);
});

test("the readout is a whole percentage", () => {
  expect(percent(1)).toBe("100%");
  expect(percent(0.1)).toBe("10%");
  expect(percent(436 / 600)).toBe("73%");
  expect(percent(MAX_ZOOM)).toBe("400%");
});

test("centring on a world point (E10.6: an avatar jumps to that person's selection) puts it in the middle of the view, at the same zoom", () => {
  const view = { width: 1000, height: 500 };
  for (const world of [{ x: 0, y: 0 }, { x: 480, y: 300 }, { x: -2000, y: 7.5 }]) {
    const centred = centreOn(v, view, world);
    expect(centred.zoom).toBe(v.zoom);
    close(toScreen(centred, world), { x: 500, y: 250 });
  }
});
