import type { Doc, DocNode, Op } from "@noon/contracts";

export { validate } from "./validate.ts";

export const ROOT_ID = "root";

export const emptyDoc = (): Doc => ({
  rootId: ROOT_ID,
  nodes: { [ROOT_ID]: { id: ROOT_ID, component: "Page", props: {}, parentId: null, children: [] } },
});

/** `doc.nodes[id]`, but never something inherited from Object.prototype ("constructor", "__proto__"...). */
export const nodeOf = (doc: Doc, id: string): DocNode | undefined => (Object.hasOwn(doc.nodes, id) ? doc.nodes[id] : undefined);

/** What one op changes: nodes to write and nodes to delete. `undefined` = the op changes nothing. */
type Patch = { set: DocNode[]; remove: string[] };

/**
 * The ONE place that decides what an op does. It reads the document and never writes it; the two
 * appliers below turn its answer into a new document or into an in-place edit.
 *
 * TOTAL: any op has a defined result. An op that no longer makes sense (its node was removed, its
 * parent is gone, it would make a cycle) or that would change nothing yields `undefined`. That is
 * how "a remove beats a concurrent edit" falls out with no special cases. Saying WHY an op is
 * refused is validate()'s job, not this function's.
 */
function plan(doc: Doc, op: Op): Patch | undefined {
  // The contract refuses names that live on Object.prototype ("__proto__", "constructor"...). If one
  // arrives anyway (a journal row from before that rule, a caller that skipped the contract), storing
  // it would either call a setter or shadow a built-in, so such an op simply does nothing.
  const names = [op.nodeId, ...(op.type === "add_node" ? [op.parentId, ...Object.keys(op.props)] : op.type === "move_node" ? [op.newParentId] : op.type === "set_prop" ? [op.key] : [])];
  if (names.some((name) => name in Object.prototype)) return undefined;

  switch (op.type) {
    case "add_node": {
      const parent = nodeOf(doc, op.parentId);
      if (!parent || nodeOf(doc, op.nodeId)) return undefined;
      const node: DocNode = { id: op.nodeId, component: op.component, props: { ...op.props }, parentId: parent.id, children: [] };
      return { set: [{ ...parent, children: insertAt(parent.children, op.index, node.id) }, node], remove: [] };
    }
    case "move_node": {
      const node = nodeOf(doc, op.nodeId);
      const target = nodeOf(doc, op.newParentId);
      if (!node || !target || node.parentId === null || isInSubtree(doc, target.id, node.id)) return undefined;
      const oldParent = nodeOf(doc, node.parentId);
      if (!oldParent) return undefined;
      // Take it out first, THEN insert: `index` is the node's FINAL position in the target's children.
      const without = oldParent.children.filter((id) => id !== node.id);
      if (oldParent.id === target.id) {
        const children = insertAt(without, op.index, node.id);
        const unchanged = children.every((id, i) => id === oldParent.children[i]);
        return unchanged ? undefined : { set: [{ ...target, children }], remove: [] };
      }
      return {
        set: [{ ...oldParent, children: without }, { ...target, children: insertAt(target.children, op.index, node.id) }, { ...node, parentId: target.id }],
        remove: [],
      };
    }
    case "remove_node": {
      const node = nodeOf(doc, op.nodeId);
      if (!node || node.parentId === null) return undefined; // unknown node, or the root
      const parent = nodeOf(doc, node.parentId);
      if (!parent) return undefined;
      return { set: [{ ...parent, children: parent.children.filter((id) => id !== node.id) }], remove: subtree(doc, node.id) };
    }
    case "set_prop": {
      const node = nodeOf(doc, op.nodeId);
      if (!node || node.parentId === null) return undefined; // unknown node, or the root (which has no props)
      const current = Object.hasOwn(node.props, op.key) ? node.props[op.key] : undefined;
      if (op.value === null ? current === undefined : Object.is(current, op.value)) return undefined;
      const props = Object.fromEntries(Object.entries(node.props).filter(([key]) => key !== op.key));
      if (op.value !== null) props[op.key] = op.value;
      return { set: [{ ...node, props }], remove: [] };
    }
    default: {
      const unreachable: never = op; // a fifth op type stops compiling here (Lesson 0, section 3)
      return unreachable;
    }
  }
}

/**
 * PURE: returns a new document and never touches `doc`; untouched nodes are shared, not copied.
 * An op that changes nothing returns the SAME object. This is what a browser uses for optimistic
 * edits, because it must be able to throw a guess away and start again from the confirmed document.
 * ponytail: it copies the node map, so it costs O(nodes) per op. Fine for a browser's pending
 * queue; a persistent map is the upgrade if a very large document makes reconcile slow.
 */
export function applyOp(doc: Doc, op: Op): Doc {
  const patch = plan(doc, op);
  if (!patch) return doc;
  const doomed = new Set(patch.remove);
  const nodes: Doc["nodes"] = {};
  for (const [id, node] of Object.entries(doc.nodes)) if (!doomed.has(id)) nodes[id] = node;
  for (const node of patch.set) nodes[node.id] = node;
  return { ...doc, nodes };
}

/**
 * IN PLACE: edits `doc` and says whether anything changed. Same decisions as applyOp (both ask
 * plan()), but O(what changed) instead of O(nodes). The room and journal replay use this one:
 * replaying 10,000 ops through the copying applier took 13-26 s, against a 2 s budget (F19).
 */
export function applyOpInto(doc: Doc, op: Op): boolean {
  const patch = plan(doc, op);
  if (!patch) return false;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- ids are data; they are hasOwn-checked and never reserved names
  for (const id of patch.remove) delete doc.nodes[id];
  for (const node of patch.set) doc.nodes[node.id] = node;
  return true;
}

function insertAt(list: readonly string[], index: number, id: string): string[] {
  const at = Math.max(0, Math.min(index, list.length)); // clamp (SPEC §2.4)
  return [...list.slice(0, at), id, ...list.slice(at)];
}

/** `id` and everything under it, each node once. Iterative (a deep tree must not overflow the stack), and it terminates on a cyclic document. */
function subtree(doc: Doc, id: string): string[] {
  const seen = new Set<string>();
  const stack = [id];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(nodeOf(doc, next)?.children ?? []));
  }
  return [...seen];
}

/** Is `candidate` the node `ancestor` or somewhere below it? Walks UP from the candidate: O(depth). */
function isInSubtree(doc: Doc, candidate: string, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at: string | null | undefined = candidate; at != null && !seen.has(at); at = nodeOf(doc, at)?.parentId) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

/**
 * Every way a document could be malformed. Empty = well formed. Whoever loads a document from
 * outside (a snapshot, a repaired journal) calls this BEFORE trusting it, so it must survive the
 * worst input: cycles, dangling ids, nodes under the wrong key.
 */
export function checkDoc(doc: Doc): string[] {
  // First the shape of every node: a document that skipped the contract may hold anything at all,
  // and the structural checks below assume `children` is an array of strings.
  const malformed = Object.entries(doc.nodes as Record<string, unknown>)
    .filter(([, n]) => typeof n !== "object" || n === null || !Array.isArray((n as { children?: unknown }).children) || typeof (n as { id?: unknown }).id !== "string")
    .map(([id]) => `${id}: not a well-formed node`);
  if (malformed.length > 0) return malformed;

  const root = nodeOf(doc, doc.rootId);
  if (!root) return [`root ${doc.rootId} is missing`];
  const problems: string[] = [];
  if (root.parentId !== null) problems.push("the root has a parent");

  let visits = 0;
  for (const id of Object.keys(doc.nodes)) visits += nodeOf(doc, id)?.children.length ?? 0;
  const reachable = new Set(subtree(doc, doc.rootId));
  // In a tree every node except the root is somebody's child exactly once.
  if (visits !== Object.keys(doc.nodes).length - 1 || [...reachable].some((id) => !nodeOf(doc, id))) {
    const counts = new Map<string, number>();
    for (const id of Object.keys(doc.nodes)) for (const child of nodeOf(doc, id)?.children ?? []) counts.set(child, (counts.get(child) ?? 0) + 1);
    for (const [child, count] of counts) if (count > 1 || child === doc.rootId) problems.push(`${child}: a node is reachable twice (cycle or shared child)`);
  }
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.id !== id) problems.push(`${id}: stored under the wrong key`);
    if (!reachable.has(id)) problems.push(`${id}: not reachable from the root`);
    for (const child of node.children) {
      const found = nodeOf(doc, child);
      if (!found) problems.push(`${id} -> ${child}: child does not exist`);
      else if (found.parentId !== id) problems.push(`${id} -> ${child}: child does not point back`);
    }
  }
  return problems;
}
