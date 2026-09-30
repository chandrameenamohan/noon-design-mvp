/**
 * The canvas viewport (E10.2): where the page frame sits on the screen. Pure maths, no DOM, so it is
 * tested as arithmetic (viewport.test.ts) and the component only wires events to it.
 *
 * One convention everywhere: screen = world * zoom + offset. `x`, `y` are the SCREEN position (inside
 * the canvas element) of the world origin; `zoom` is the scale, 1 = 100 %. The frame is drawn at the
 * world origin, so the whole transform is one CSS `translate(x, y) scale(zoom)` on one layer.
 */
export type Viewport = { x: number; y: number; zoom: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** One press of + or - (Figma's ladder is finer; a constant ratio is enough to read the percentage). */
const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export const toWorld = (v: Viewport, screen: Point): Point => ({ x: (screen.x - v.x) / v.zoom, y: (screen.y - v.y) / v.zoom });
export const toScreen = (v: Viewport, world: Point): Point => ({ x: world.x * v.zoom + v.x, y: world.y * v.zoom + v.y });

/** Zooms to `zoom` (clamped) so that the world point under `anchor` (a screen point: the pointer, the view's centre) stays under it. */
export function zoomAt(v: Viewport, zoom: number, anchor: Point): Viewport {
  const next = clampZoom(zoom);
  const held = toWorld(v, anchor);
  return { zoom: next, x: anchor.x - held.x * next, y: anchor.y - held.y * next };
}

export const zoomStep = (zoom: number, direction: 1 | -1): number => clampZoom(direction === 1 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP);

/**
 * The zoom after one wheel event: a pinch on a trackpad arrives as many small deltas (ctrl+wheel), a
 * mouse notch as one of about 100. Exponential, so up then down by the same amount lands where it
 * started; the factor is capped so one wild notch cannot jump the whole range.
 */
export function wheelZoom(zoom: number, deltaY: number): number {
  const factor = Math.min(2, Math.max(0.5, Math.exp(-deltaY * 0.005)));
  return clampZoom(zoom * factor);
}

export const panBy = (v: Viewport, dx: number, dy: number): Viewport => ({ ...v, x: v.x + dx, y: v.y + dy });

/** The whole content visible and centred, with `padding` screen pixels around it; never past the zoom limits. */
export function fit(view: Size, content: Size, padding = 32): Viewport {
  const zoom = clampZoom(Math.min((view.width - 2 * padding) / content.width, (view.height - 2 * padding) / content.height));
  return { zoom, x: (view.width - content.width * zoom) / 2, y: (view.height - content.height * zoom) / 2 };
}

/** The viewport that shows `world` in the middle of the view, at the zoom it has (E10.6: jumping to someone's selection). */
export const centreOn = (v: Viewport, view: Size, world: Point): Viewport => ({ zoom: v.zoom, x: view.width / 2 - world.x * v.zoom, y: view.height / 2 - world.y * v.zoom });

export const percent = (zoom: number): string => `${String(Math.round(zoom * 100))}%`;
