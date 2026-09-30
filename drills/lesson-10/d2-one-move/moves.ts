// DRILL 2 · one bug from Lesson 10 is planted in this file. Find it and fix it HERE.
//
// `dropToMoveOp` of apps/web/src/layer-moves.ts cut down to its decision (E10.3): a layer was dropped before or
// after a row, or into a container, and the tree must send what that means to the document, through the one
// write path. Left out: the keyboard's four moves, the cycle guard against a corrupt document, the placement from
// the pointer's height on the row. Kept: what the drop SENDS.
//
// The layers tree is the document rendered; it never edits it. Whatever this returns goes to `peer.submit` one op at
// a time, the replica applies each at once (what the person sees), the room orders each and tells everyone, and each
// is a row in the op journal and the audit trail.
import type { Doc, Op } from "@noon/contracts";

export type Placement = "before" | "after" | "into";
export type Drop = { nodeId: string; targetId: string; placement: Placement };

/** `id` itself, or a node below it. */
function within(doc: Doc, id: string, ancestor: string): boolean {
  for (let at: string | null | undefined = id; at != null; at = doc.nodes[at]?.parentId) if (at === ancestor) return true;
  return false;
}

/** Where the dropped node is to land: its new parent, and its index among that parent's children. */
function landing(doc: Doc, drop: Drop): { parentId: string; index: number } | null {
  const target = doc.nodes[drop.targetId];
  if (!target) return null;
  if (drop.placement === "into") return { parentId: target.id, index: target.children.length };
  if (target.parentId === null) return null; // beside the page: there is no such place
  const parent = doc.nodes[target.parentId];
  if (!parent) return null;
  return { parentId: parent.id, index: parent.children.indexOf(target.id) + (drop.placement === "after" ? 1 : 0) };
}

/** The ops a drop sends, in order; empty when there is nowhere to go (the page, onto itself, into its own subtree). */
export function dropToOps(doc: Doc, drop: Drop): Op[] {
  const node = doc.nodes[drop.nodeId];
  if (!node || node.parentId === null) return [];
  if (within(doc, drop.targetId, drop.nodeId)) return [];
  const to = landing(doc, drop);
  if (!to) return [];
  // Take it out of where it is, then put a node like it where it goes.
  return [
    { type: "remove_node", nodeId: node.id },
    { type: "add_node", nodeId: crypto.randomUUID(), parentId: to.parentId, index: to.index, component: node.component, props: node.props },
  ];
}
