// DRILL 2 · one bug from Lesson 5 is planted in this file. Find it and fix it HERE.
//
// "A push becomes ops", cut down to the decision that matters. The real one is `pushOps` in
// apps/worker/src/push-ops.ts; this copy handles adds, props and removes (moves, and the longest run of
// siblings that need none, are left to the real one). The ideas are the same: an engineer pushed a page,
// the canvas has kept editing since the page they started from was generated, and the ops sent to the room
// must be what the ENGINEER changed, replayed on the document as it is now.
import type { Doc, Op } from "@noon/contracts";
import { applyOpInto, nodeOf } from "../../../packages/doc-model/src/index.ts";

export type PushOps = { ok: true; ops: Op[] } | { ok: false; reason: "root_mismatch" | "reused_node_id" | "component_changed"; detail: string };

export function pushOps({ base, target, current, earlierIds }: {
  /** The page before the push, if it was there and in shape. Missing: the document is the base (the push is taken as the whole page). */
  base: Doc | undefined;
  /** The page the engineer pushed. */
  target: Doc;
  /** The document now: `peer.confirmed`, never the optimistic one. */
  current: Doc;
  /** Every node id the page has held in the repo's history up to the base: an id that is gone from the base was removed. */
  earlierIds: ReadonlySet<string>;
}): PushOps {
  if (target.rootId !== current.rootId) return { ok: false, reason: "root_mismatch", detail: `the file's page is ${target.rootId}, the document's is ${current.rootId}` };
  // What the engineer's changes are measured against.
  const from = current;
  // Keystone 4: an id that was removed is never added again, or an edit meant for the dead node would land
  // on the new one. A new id the document already holds is the same mistake, seen from the other side.
  for (const id of preorder(target)) {
    const was = nodeOf(from, id);
    if (!was && (earlierIds.has(id) || nodeOf(current, id))) return { ok: false, reason: "reused_node_id", detail: `${id} was part of this document before` };
    if (was && was.component !== nodeOf(target, id)?.component) return { ok: false, reason: "component_changed", detail: `${id} was a ${was.component}` };
  }

  // Each op is tried on a copy of the document as it is made. One that would change nothing there (its node
  // or its parent was removed on the canvas meanwhile) is not sent: the same result the room would reach.
  const working = structuredClone(current);
  const ops: Op[] = [];
  const emit = (op: Op): void => { if (applyOpInto(working, op)) ops.push(op); };
  /** The final index that puts a node right after `anchor` among `parentId`'s children (first, with no anchor). */
  const after = (parentId: string, nodeId: string, anchor: string | undefined): number => {
    const siblings = (nodeOf(working, parentId)?.children ?? []).filter((id) => id !== nodeId);
    return anchor === undefined ? 0 : siblings.indexOf(anchor) + 1;
  };

  // 1. Adds, parents before children, so a node's new parent is in place before it arrives.
  for (const parentId of preorder(target)) {
    let anchor: string | undefined;
    for (const id of nodeOf(target, parentId)?.children ?? []) {
      const node = nodeOf(target, id);
      if (node && !nodeOf(from, id)) emit({ type: "add_node", nodeId: id, parentId, index: after(parentId, id, anchor), component: node.component, props: { ...node.props } });
      if (nodeOf(working, id)?.parentId === parentId) anchor = id;
    }
  }
  // 2. Props of the nodes both pages hold (an added node brought its own).
  for (const id of preorder(target)) {
    const before = nodeOf(from, id)?.props;
    const now = nodeOf(target, id)?.props;
    if (!before || !now || id === target.rootId) continue;
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(now)])].sort()) {
      const value = Object.hasOwn(now, key) ? now[key] : undefined;
      if ((Object.hasOwn(before, key) ? before[key] : undefined) !== value) emit({ type: "set_prop", nodeId: id, key, value: value ?? null });
    }
  }
  // 3. Removes, last. Parents first, so a removed subtree is one op.
  for (const id of preorder(from)) if (id !== from.rootId && !nodeOf(target, id)) emit({ type: "remove_node", nodeId: id });
  return { ok: true, ops };
}

/** Every id from the root down, parents before children, siblings in order. Iterative: a deep page must not overflow the stack. */
function preorder(doc: Doc): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [doc.rootId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const children = nodeOf(doc, id)?.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] ?? "");
  }
  return out.filter((id) => nodeOf(doc, id));
}
