// DRILL 3 · one bug from Lesson 10 is planted in this file. Find it and fix it HERE.
//
// Surface.tsx's `onPointerMove` and the cursor marks cut down to their decision (E10.6): what THIS window sends
// about its pointer, and where THIS window draws a cursor it was sent. Two windows on one document have their own
// size, zoom and pan (E10.2), and the other person's arrow must sit on the same component in both.
//
// The real surface draws the marks inside `.world`, so the CSS transform places them; here `cursorToDraw` does that
// arithmetic by hand so a test can look at the result. Left out: hover, the click, the AI's node anchor, the fade.
import { hundredths, toScreen, type Point, type Viewport } from "./viewport.ts";

/** What rides the wire (contracts: Cursor): a spot on the infinite sheet. */
export type Cursor = { x: number; y: number };

/**
 * What to send for a pointer event: `client` is the event's clientX/clientY, `canvas` the top-left of the canvas
 * element on the screen (getBoundingClientRect), `viewport` where this window's world origin sits and at what zoom.
 */
export function cursorToSend(viewport: Viewport, canvas: Point, client: Point): Cursor {
  void viewport; // the sheet is where the pointer is; the zoom only changes how big things look
  return { x: hundredths(client.x - canvas.x), y: hundredths(client.y - canvas.y) };
}

/** Where a cursor received is drawn: a screen point inside this window's canvas element. */
export function cursorToDraw(viewport: Viewport, cursor: Cursor): Point {
  return toScreen(viewport, cursor);
}
