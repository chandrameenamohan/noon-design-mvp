// The canvas viewport, as apps/web/src/viewport.ts has it (E10.2): the one convention everywhere is
// screen = world * zoom + offset. Re-exported here so the drill reads as one folder; the code is the repo's.
export { toScreen, toWorld, type Point, type Viewport } from "../../../apps/web/src/viewport.ts";

/** Two decimals: a sub-pixel is noise on the wire (Surface.tsx). */
export const hundredths = (n: number): number => Math.round(n * 100) / 100;
