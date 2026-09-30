/**
 * The spaces an auto-layout control stands for (E10.4), as rectangles to shade on the canvas. Pure: the
 * surface measures the boxes and reads the computed padding; this only draws the geometry.
 */
export type Rect = { left: number; top: number; right: number; bottom: number };
export type Sides = { top: number; right: number; bottom: number; left: number };

const nonEmpty = (r: Rect): boolean => r.right > r.left && r.bottom > r.top;

/** The four strips between a box's edge and its content: the top and bottom run the full width, the sides sit between them. */
export function paddingRing(box: Rect, padding: Sides): Rect[] {
  const innerTop = box.top + padding.top;
  const innerBottom = box.bottom - padding.bottom;
  return [
    { left: box.left, top: box.top, right: box.right, bottom: innerTop },
    { left: box.left, top: innerBottom, right: box.right, bottom: box.bottom },
    { left: box.left, top: innerTop, right: box.left + padding.left, bottom: innerBottom },
    { left: box.right - padding.right, top: innerTop, right: box.right, bottom: innerBottom },
  ].filter(nonEmpty);
}

/**
 * The space between each pair of consecutive children: to the right when the next one starts past this
 * one's right edge, below when it starts past the bottom, spanning both boxes on the other axis. Children
 * that touch or overlap (a wrapping row, say) have no gap to show, and are simply skipped.
 */
export function gapsBetween(children: readonly Rect[]): Rect[] {
  const gaps: Rect[] = [];
  for (let i = 1; i < children.length; i++) {
    const a = children[i - 1];
    const b = children[i];
    if (!a || !b) continue;
    if (b.left > a.right) gaps.push({ left: a.right, top: Math.min(a.top, b.top), right: b.left, bottom: Math.max(a.bottom, b.bottom) });
    else if (b.top > a.bottom) gaps.push({ left: Math.min(a.left, b.left), top: a.bottom, right: Math.max(a.right, b.right), bottom: b.top });
  }
  return gaps;
}
