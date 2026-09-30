import { expect, test } from "vitest";
import { clampPreviewWidth, defaultPreviewWidth, DEVICES, frameScale, maxPreviewWidth, MIN_CANVAS, MIN_PREVIEW } from "./preview-split.ts";

// E10.7: the device frames and the divider, as arithmetic.

test("the three frames are phone 390, tablet 768, desktop 1280, each taller than wide except the desktop", () => {
  expect(DEVICES.map((d) => [d.name, d.width])).toEqual([["Phone", 390], ["Tablet", 768], ["Desktop", 1280]]);
  for (const d of DEVICES) expect(d.name === "Desktop" ? d.width > d.height : d.height > d.width).toBe(true);
});

test("a device fits its pane on both axes with the padding, and is never blown up past life size", () => {
  const phone = { width: 390, height: 844 };
  // A pane wider than the phone but shorter: the height decides.
  expect(frameScale({ width: 800, height: 454 }, phone, 16)).toBeCloseTo(422 / 844, 9);
  // A narrow pane: the width decides.
  expect(frameScale({ width: 227, height: 2000 }, phone, 16)).toBeCloseTo(195 / 390, 9);
  // Room to spare: 1, not more.
  expect(frameScale({ width: 2000, height: 2000 }, phone, 16)).toBe(1);
  // The whole frame, scaled, then fits inside the pane less the padding.
  for (const pane of [{ width: 420, height: 600 }, { width: 1200, height: 300 }, { width: 500, height: 900 }]) {
    for (const device of DEVICES) {
      const scale = frameScale(pane, device);
      expect(device.width * scale).toBeLessThanOrEqual(pane.width - 32 + 1e-9);
      expect(device.height * scale).toBeLessThanOrEqual(pane.height - 32 + 1e-9);
    }
  }
});

test("a pane not yet laid out (0 by 0), or a nonsense one, gives a scale that still draws something", () => {
  expect(frameScale({ width: 0, height: 0 }, DEVICES[0] ?? { width: 1, height: 1 })).toBe(0.05);
  expect(frameScale({ width: Number.NaN, height: 10 }, { width: 390, height: 844 })).toBe(1);
  expect(frameScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1);
});

test("the divider keeps both the preview and the canvas at least their minimum, and starts in the middle", () => {
  expect(clampPreviewWidth(10, 1000)).toBe(MIN_PREVIEW);
  expect(clampPreviewWidth(950, 1000)).toBe(1000 - MIN_CANVAS);
  expect(clampPreviewWidth(500.4, 1000)).toBe(500);
  expect(defaultPreviewWidth(1000)).toBe(500);
  expect(defaultPreviewWidth(300)).toBe(MIN_PREVIEW);
  // A centre too small for both minimums: the preview keeps its own; the canvas gives way (the narrow layout stacks them anyway).
  expect(maxPreviewWidth(400)).toBe(MIN_PREVIEW);
  expect(clampPreviewWidth(1000, 400)).toBe(MIN_PREVIEW);
});
