import type { Doc, Op } from "@noon/contracts";

/**
 * How the layers tree turns a drop or a key into ONE move_node (E10.3). Pure: the panel measures the
 * DOM and calls in here; nothing here writes to the document but through the `submit` it is handed.
 *
 * It refuses only what is structurally impossible on the document it can see: the page itself, a
 * node dropped on itself or into its own subtree, a node placed beside the page. Everything else
 * (a container that takes no children, an index past the end, a node someone removed meanwhile) is
 * the replica's and the room's verdict, shown as their refusal: guessing it here would be a second
 * copy of validate() that drifts.
 */
export type MoveOp = Extract<Op, { type: "move_node" }>;
export type Placement = "before" | "after" | "into";
/** Where a layer is to land: beside a row (its new sibling), or inside it (its new parent), at the end. */
export type Drop = { nodeId: string; targetId: string; placement: Placement };

/** `id` itself, or a node below it. `seen`: a document with a cycle must not hang the tab. */
function within(doc: Doc, id: string, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at: string | null | undefined = id; at != null && !seen.has(at); at = doc.nodes[at]?.parentId) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

/**
 * The op a drop means, or null when there is nowhere to go. `index` is the node's FINAL position
 * among its new siblings, counted after it was taken out (SPEC §2.4): dropping a node after its own
 * next sibling is index at+1 counted without it, which is why the siblings are filtered first.
 */
export function dropToMoveOp(doc: Doc, drop: Drop): MoveOp | null {
  const node = doc.nodes[drop.nodeId];
  const target = doc.nodes[drop.targetId];
  if (!node || !target || node.parentId === null) return null;
  if (within(doc, drop.targetId, drop.nodeId)) return null; // onto itself, or into its own subtree
  if (drop.placement === "into") return { type: "move_node", nodeId: node.id, newParentId: target.id, index: target.children.filter((id) => id !== node.id).length };
  if (target.parentId === null) return null; // beside the page: there is no such place
  const parent = doc.nodes[target.parentId];
  if (!parent) return null;
  const siblings = parent.children.filter((id) => id !== node.id);
  return { type: "move_node", nodeId: node.id, newParentId: parent.id, index: siblings.indexOf(target.id) + (drop.placement === "after" ? 1 : 0) };
}

/**
 * What a pointer at `fraction` of a row's height (0 = top edge, 1 = bottom) means. A container's
 * middle half is "into"; a row that cannot hold children only has a top half and a bottom half, so
 * the pointer can never mean "into" it and the line shows where the node WOULD go.
 */
export function placementAt(fraction: number, container: boolean): Placement {
  if (!container) return fraction < 0.5 ? "before" : "after";
  return fraction < 0.25 ? "before" : fraction >= 0.75 ? "after" : "into";
}

export type KeyMove = "up" | "down" | "nest" | "outdent";

/**
 * The keyboard's four moves, as drops: Alt+Up is "before my previous sibling", Alt+Down "after my next",
 * Alt+Right "into my previous sibling" (the room says whether it takes children), Alt+Left "after my
 * parent". Null at an edge (the first sibling's up, a page child's outdent): the key does nothing.
 */
export function keyMoveOp(doc: Doc, nodeId: string, move: KeyMove): MoveOp | null {
  const node = doc.nodes[nodeId];
  if (!node || node.parentId === null) return null;
  const parent = doc.nodes[node.parentId];
  if (!parent) return null;
  const at = parent.children.indexOf(nodeId);
  const previous = parent.children[at - 1];
  const next = parent.children[at + 1];
  const drop: Drop | null =
    move === "up" ? (previous === undefined ? null : { nodeId, targetId: previous, placement: "before" })
    : move === "down" ? (next === undefined ? null : { nodeId, targetId: next, placement: "after" })
    : move === "nest" ? (previous === undefined ? null : { nodeId, targetId: previous, placement: "into" })
    : parent.parentId === null ? null : { nodeId, targetId: parent.id, placement: "after" };
  return drop && dropToMoveOp(doc, drop);
}

/**
 * One move_node, sent through `submit` and said for the live region: a new parent is named, a new place among the
 * same siblings is numbered. Worded BEFORE the submit: the replica applies the op to `doc` in place, so afterwards
 * every move looks like a reorder. "" when the replica refused it (noon-2h1.3.1): the refusal is the alert's to say,
 * and the document did not change.
 */
export function moveSaid(doc: Doc, op: MoveOp, labelOf: (id: string) => string, submit: (op: MoveOp) => boolean): string {
  const sentence = `${labelOf(op.nodeId)} moved ${op.newParentId === doc.nodes[op.nodeId]?.parentId ? `to position ${String(op.index + 1)}` : `into ${labelOf(op.newParentId)}`}`;
  return submit(op) ? sentence : "";
}

/** A node in reading order, as the layers list names it, and how deep it sits (the page is depth 0). */
export type Row = { id: string; label: string; depth: number };

/** The rows a person sees: everything under a collapsed row, however deep, is hidden until it opens again. */
export function visibleRows(rows: readonly Row[], collapsed: ReadonlySet<string>): Row[] {
  const shown: Row[] = [];
  let hiddenBelow: number | null = null;
  for (const row of rows) {
    if (hiddenBelow !== null && row.depth > hiddenBelow) continue;
    hiddenBelow = collapsed.has(row.id) ? row.depth : null;
    shown.push(row);
  }
  return shown;
}
