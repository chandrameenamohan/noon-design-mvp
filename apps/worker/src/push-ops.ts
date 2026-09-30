import type { Doc, Op } from "@noon/contracts";
import { applyOpInto, nodeOf } from "@noon/doc-model";

/**
 * E5.3b: what a push means for the open document, as ops. A THREE-WAY diff: `base` is the page the
 * engineer started from (the file at the commit before the push), `target` the page they pushed, and
 * the ops are what they changed, replayed on the document as it is NOW. Diffing the pushed file
 * against the document instead would undo every canvas edit made since that file was generated.
 *
 * Minimal: a prop that did not change is not sent, a node that kept its place among its siblings is
 * not moved (the longest run of siblings still in order stays), and a removed subtree is one remove.
 * Deterministic: everything is walked in tree order and props in name order, never in key order.
 *
 * Each op is tried on a copy of the document as it is made. One that would change nothing there (its
 * node or its parent was removed on the canvas meanwhile, the value is already set, the move would make
 * a cycle) is not sent: the same result the room would reach, as keystone 4's concurrent edits do.
 */

export type PushOps = { ok: true; ops: Op[] } | { ok: false; reason: "root_mismatch" | "reused_node_id" | "component_changed"; detail: string };

export function pushOps({ base, target, current, earlierIds }: {
  /** The page before the push, if it was there and in shape. Missing: the document is the base (the push is taken as the whole page). */
  base: Doc | undefined;
  target: Doc;
  /** The document now: `peer.confirmed`, never the optimistic one. */
  current: Doc;
  /** Every node id the page has held in the repo's history up to the base: an id that is gone from the base was removed. */
  earlierIds: ReadonlySet<string>;
}): PushOps {
  if (target.rootId !== current.rootId) return { ok: false, reason: "root_mismatch", detail: `the file's page is ${target.rootId}, the document's is ${current.rootId}` };
  const from = base?.rootId === current.rootId ? base : current;
  // Keystone 4: an id that was removed is never added again, or an edit meant for the dead node would land
  // on the new one. A new id the document already holds is the same mistake, seen from the other side.
  for (const id of preorder(target)) {
    const was = nodeOf(from, id);
    if (!was && (earlierIds.has(id) || nodeOf(current, id))) return { ok: false, reason: "reused_node_id", detail: `${id} was part of this document before` };
    // No op changes what a node IS; a remove and an add would re-use its id.
    if (was && was.component !== nodeOf(target, id)?.component) return { ok: false, reason: "component_changed", detail: `${id} was a ${was.component}` };
  }

  const working = structuredClone(current);
  const ops: Op[] = [];
  const emit = (op: Op): void => { if (applyOpInto(working, op)) ops.push(op); };
  /** The final index that puts a node right after `anchor` among `parentId`'s children (first, with no anchor). */
  const after = (parentId: string, nodeId: string, anchor: string | undefined): number => {
    const siblings = (nodeOf(working, parentId)?.children ?? []).filter((id) => id !== nodeId);
    return anchor === undefined ? 0 : siblings.indexOf(anchor) + 1;
  };

  // 1. Adds and moves, parents before children, so a node's new parent is in place before it arrives.
  for (const parentId of preorder(target)) {
    const children = nodeOf(target, parentId)?.children ?? [];
    const stays = inOrder(children, nodeOf(from, parentId)?.children ?? [], (id) => nodeOf(from, id)?.parentId === parentId);
    let anchor: string | undefined;
    for (const id of children) {
      const node = nodeOf(target, id);
      if (!node) continue;
      if (!nodeOf(from, id)) emit({ type: "add_node", nodeId: id, parentId, index: after(parentId, id, anchor), component: node.component, props: { ...node.props } });
      else if (!stays.has(id)) emit({ type: "move_node", nodeId: id, newParentId: parentId, index: after(parentId, id, anchor) });
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
  // 3. Removes, last: what was moved out of a removed node is out by now. Parents first, so a removed
  // subtree is one op (its descendants are gone from `working` by the time they come up).
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

/**
 * The siblings that need no move: of those that were already under this parent, the longest run that is
 * still in the old order (a longest increasing subsequence of their old positions, O(n log n)). Among
 * runs of the same length it keeps the one that ends lowest, the same one every time.
 */
function inOrder(now: readonly string[], before: readonly string[], wasHere: (id: string) => boolean): Set<string> {
  const position = new Map(before.map((id, i) => [id, i]));
  const ids = now.filter((id) => wasHere(id) && position.has(id));
  const tails: number[] = []; // tails[k]: index in `ids` of the smallest end of a run of length k+1
  const previous: number[] = [];
  ids.forEach((id, i) => {
    const p = position.get(id) ?? 0;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((position.get(ids[tails[mid] ?? 0] ?? "") ?? 0) < p) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? (tails[lo - 1] ?? -1) : -1;
    tails[lo] = i;
  });
  const stays = new Set<string>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i] ?? -1) stays.add(ids[i] ?? "");
  return stays;
}
