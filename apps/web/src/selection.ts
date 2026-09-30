import type { Doc } from "@noon/contracts";
import type { Point } from "./viewport.ts";

/**
 * Which node a pointer or a key picks (E10.2). Pure: the component measures the DOM and calls in here.
 */

/** A node's box on the screen, with how deep it sits in the tree. */
export type Box = { id: string; depth: number; left: number; top: number; right: number; bottom: number };

/**
 * The node under the point: the DEEPEST one, because a child is drawn on top of its parent and is
 * what the eye lands on. Among equals (siblings that overlap), the later in document order, which is
 * the one painted last. Nothing under the point = null (the empty canvas; the caller selects the page).
 */
export function hitTest(boxes: readonly Box[], point: Point): string | null {
  let hit: Box | null = null;
  for (const box of boxes) {
    if (point.x < box.left || point.x >= box.right || point.y < box.top || point.y >= box.bottom) continue;
    if (!hit || box.depth >= hit.depth) hit = box;
  }
  return hit?.id ?? null;
}

export type Step = "next" | "previous" | "in" | "out";

/**
 * Keyboard selection: arrows walk siblings, Enter goes into the first child, Shift+Enter to the parent.
 * A step that cannot be taken (the first sibling's "previous", a leaf's "in", the page's "out") keeps
 * the selection where it is, so the keys never land on nothing.
 */
export function step(doc: Doc, id: string, to: Step): string {
  const node = doc.nodes[id];
  if (!node) return doc.rootId;
  if (to === "in") return node.children[0] ?? id;
  if (to === "out") return node.parentId ?? id;
  if (node.parentId === null) return id;
  const siblings = doc.nodes[node.parentId]?.children ?? [];
  const at = siblings.indexOf(id);
  return siblings[at + (to === "next" ? 1 : -1)] ?? id;
}
