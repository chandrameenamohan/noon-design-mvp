import type { Size } from "./viewport.ts";

/**
 * The preview split (E10.7): the running page beside the canvas, in a device frame. PURE: sizes in, a
 * scale or a width out; Preview.tsx binds them to the pane's measured size and the divider's drag.
 */
export type Device = Size & { name: "Phone" | "Tablet" | "Desktop" };

/** The three frames, by CSS px: a common phone, a portrait tablet, a laptop. Custom sizes are out of scope. */
export const DEVICES: readonly Device[] = [
  { name: "Phone", width: 390, height: 844 },
  { name: "Tablet", width: 768, height: 1024 },
  { name: "Desktop", width: 1280, height: 800 },
];

/**
 * The preview's own zoom-to-fit: the scale that shows the whole device in the pane with `padding` px round
 * it, never above 1 (a phone in a wide pane is life-size, not blown up) and never so small that nothing
 * is left (a pane still being laid out measures 0).
 */
export function frameScale(pane: Size, device: Size, padding = 16): number {
  const fitted = Math.min((pane.width - 2 * padding) / device.width, (pane.height - 2 * padding) / device.height);
  return Number.isFinite(fitted) ? Math.min(1, Math.max(0.05, fitted)) : 1;
}

/** The preview never narrower than this, and the canvas beside it never narrower than MIN_CANVAS. */
export const MIN_PREVIEW = 280;
export const MIN_CANVAS = 240;

/** The widest the preview may be in a centre `centreWidth` wide: what leaves the canvas its minimum, but never below the preview's own. */
export const maxPreviewWidth = (centreWidth: number): number => Math.max(MIN_PREVIEW, centreWidth - MIN_CANVAS);
/** A wanted preview width, held within both minimums. */
export const clampPreviewWidth = (wanted: number, centreWidth: number): number => Math.round(Math.min(maxPreviewWidth(centreWidth), Math.max(MIN_PREVIEW, wanted)));
/** Where the divider first sits: half the centre, unless a minimum says otherwise. */
export const defaultPreviewWidth = (centreWidth: number): number => clampPreviewWidth(centreWidth / 2, centreWidth);
