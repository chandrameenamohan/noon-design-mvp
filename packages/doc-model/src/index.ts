import type { Doc, DocNode, Op } from "@noon/contracts";

export { validate } from "./validate.ts"; // RejectReason and Verdict get exported when the room (E2.3a) needs to name them

export const ROOT_ID = "root";

export const emptyDoc = (): Doc => ({
  rootId: ROOT_ID,
  nodes: { [ROOT_ID]: { id: ROOT_ID, component: "Page", props: {}, parentId: null, children: [] } },
});

/**
 * Applies one op and returns the new document. PURE and TOTAL:
 *  - pure: never mutates `doc` (untouched parts are shared, changed parts are copied), no I/O, no
 *    clock, no randomness, so the server, every browser and every test compute the same thing;
 *  - total: ANY op has a defined result. An op that no longer makes sense (its node was removed,
 *    its parent is gone, it would make a cycle) returns the SAME object, which is how "a remove
 *    beats a concurrent edit" falls out without special cases.
 * Saying WHY an op is refused is validate()'s job, not this function's.
 */
export function applyOp(doc: Doc, op: Op): Doc {
  switch (op.type) {
    case "add_node": {
      const parent = doc.nodes[op.parentId];
      if (!parent || doc.nodes[op.nodeId]) return doc;
      const node: DocNode = { id: op.nodeId, component: op.component, props: { ...op.props }, parentId: parent.id, children: [] };
      return withNodes(doc, { [parent.id]: { ...parent, children: insertAt(parent.children, op.index, node.id) }, [node.id]: node });
    }
    case "move_node": {
      const node = doc.nodes[op.nodeId];
      const target = doc.nodes[op.newParentId];
      if (!node || !target || node.parentId === null || isInSubtree(doc, target.id, node.id)) return doc;
      const oldParent = doc.nodes[node.parentId];
      if (!oldParent) return doc;
      // Take it out first, THEN insert: inside one parent the index refers to the list without the node.
      const without = oldParent.children.filter((id) => id !== node.id);
      if (oldParent.id === target.id) {
        return withNodes(doc, { [target.id]: { ...target, children: insertAt(without, op.index, node.id) } });
      }
      return withNodes(doc, {
        [oldParent.id]: { ...oldParent, children: without },
        [target.id]: { ...target, children: insertAt(target.children, op.index, node.id) },
        [node.id]: { ...node, parentId: target.id },
      });
    }
    case "remove_node": {
      const node = doc.nodes[op.nodeId];
      if (!node || node.parentId === null) return doc; // unknown node, or the root
      const parent = doc.nodes[node.parentId];
      if (!parent) return doc;
      const doomed = new Set(subtree(doc, node.id));
      const nodes: Doc["nodes"] = {};
      for (const [id, existing] of Object.entries(doc.nodes)) if (!doomed.has(id)) nodes[id] = existing;
      nodes[parent.id] = { ...parent, children: parent.children.filter((id) => id !== node.id) };
      return { ...doc, nodes };
    }
    case "set_prop": {
      const node = doc.nodes[op.nodeId];
      if (!node || node.parentId === null) return doc; // unknown node, or the root (which has no props)
      const props = { ...node.props };
      if (op.value === null) delete props[op.key]; // eslint-disable-line @typescript-eslint/no-dynamic-delete -- props is a fresh copy; the key set is data
      else props[op.key] = op.value;
      return withNodes(doc, { [node.id]: { ...node, props } });
    }
    default: {
      const unreachable: never = op; // a fifth op type stops compiling here (Lesson 0, section 3)
      return unreachable;
    }
  }
}

const withNodes = (doc: Doc, changed: Doc["nodes"]): Doc => ({ ...doc, nodes: { ...doc.nodes, ...changed } });

function insertAt(list: readonly string[], index: number, id: string): string[] {
  const at = Math.max(0, Math.min(index, list.length)); // clamp (SPEC §2.4)
  return [...list.slice(0, at), id, ...list.slice(at)];
}

/** `id` and everything under it. Iterative: a deep tree must not overflow the call stack. */
function subtree(doc: Doc, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    out.push(next);
    stack.push(...(doc.nodes[next]?.children ?? []));
  }
  return out;
}

/** Is `candidate` the node `ancestor` or somewhere below it? Walks UP from the candidate: O(depth). */
function isInSubtree(doc: Doc, candidate: string, ancestor: string): boolean {
  for (let at: string | null | undefined = candidate; at != null; at = doc.nodes[at]?.parentId) {
    if (at === ancestor) return true;
  }
  return false;
}

/** Every way a document could be malformed. Empty = well formed. For tests, the simulator and recovery. */
export function checkDoc(doc: Doc): string[] {
  const problems: string[] = [];
  const root = doc.nodes[doc.rootId];
  if (!root) return [`root ${doc.rootId} is missing`];
  if (root.parentId !== null) problems.push("the root has a parent");
  const reachable = new Set(subtree(doc, doc.rootId));
  if (reachable.size !== subtree(doc, doc.rootId).length) problems.push("a node is reachable twice (cycle or shared child)");
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.id !== id) problems.push(`${id}: stored under the wrong key`);
    if (!reachable.has(id)) problems.push(`${id}: not reachable from the root`);
    if (new Set(node.children).size !== node.children.length) problems.push(`${id}: lists a child twice`);
    for (const child of node.children) {
      if (doc.nodes[child]?.parentId !== id) problems.push(`${id} -> ${child}: child does not point back`);
    }
  }
  return problems;
}
