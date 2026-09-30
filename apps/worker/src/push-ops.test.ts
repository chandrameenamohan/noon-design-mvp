import { expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { applyOp, emptyDoc } from "@noon/doc-model";
import { randomOp, seeded } from "@noon/doc-model/random-ops";
import { pushOps } from "./push-ops.ts";

// E5.3b: the pure half of "a push becomes ops". The room, the peer and git are integration:push-becomes-ops.
const none = new Set<string>();
const build = (...ops: Op[]): Doc => ops.reduce(applyOp, emptyDoc());
const add = (nodeId: string, parentId: string, component = "Card", props: Record<string, string | number | boolean> = {}, index = 99): Op => ({ type: "add_node", nodeId, parentId, index, component, props });
const ops = (base: Doc | undefined, target: Doc, current: Doc, earlierIds: ReadonlySet<string> = none): Op[] => {
  const result = pushOps({ base, target, current, earlierIds });
  if (!result.ok) throw new Error(result.reason);
  return result.ops;
};
/** Two documents hold the same page: the same nodes, props and children in the same order (key order is not part of a page). */
const shape = (doc: Doc): string =>
  JSON.stringify(Object.keys(doc.nodes).sort().map((id) => { const node = doc.nodes[id]; return node && { ...node, props: Object.entries(node.props).sort(([a], [b]) => a.localeCompare(b)) }; }));

const page = build(add("a", "root", "Card", { title: "A" }), add("b", "root", "Button", { label: "B" }), add("c", "root", "Text", { value: "C" }), add("a1", "a", "Button", { label: "in A" }));

test("one changed prop is one set_prop, and an unchanged page is no op at all", () => {
  const edited = applyOp(page, { type: "set_prop", nodeId: "b", key: "label", value: "Pay" });
  expect(ops(page, edited, page)).toEqual([{ type: "set_prop", nodeId: "b", key: "label", value: "Pay" }]);
  expect(ops(page, page, page)).toEqual([]);
  // A prop taken out of the file is a set_prop to null: the component's default applies again.
  expect(ops(page, applyOp(page, { type: "set_prop", nodeId: "c", key: "value", value: null }), page)).toEqual([{ type: "set_prop", nodeId: "c", key: "value", value: null }]);
});

test("swapping two siblings is ONE move, and a moved subtree travels in one op", () => {
  const swapped = applyOp(page, { type: "move_node", nodeId: "c", newParentId: "root", index: 0 });
  expect(ops(page, swapped, page)).toEqual([{ type: "move_node", nodeId: "c", newParentId: "root", index: 0 }]);
  const intoA = applyOp(page, { type: "move_node", nodeId: "b", newParentId: "a", index: 0 });
  expect(ops(page, intoA, page)).toEqual([{ type: "move_node", nodeId: "b", newParentId: "a", index: 0 }]);
});

test("a removed subtree is one remove; a node moved out of it first survives", () => {
  expect(ops(page, applyOp(page, { type: "remove_node", nodeId: "a" }), page)).toEqual([{ type: "remove_node", nodeId: "a" }]);
  const rescued = [{ type: "move_node", nodeId: "a1", newParentId: "root", index: 99 }, { type: "remove_node", nodeId: "a" }] satisfies Op[];
  const target = rescued.reduce(applyOp, page);
  const result = ops(page, target, page);
  expect(result).toEqual([{ type: "move_node", nodeId: "a1", newParentId: "root", index: 3 }, { type: "remove_node", nodeId: "a" }]);
  expect(shape(result.reduce(applyOp, page))).toBe(shape(target));
});

test("new nodes arrive parent first, at their place among the siblings, with their props", () => {
  const target = [add("n", "root", "Card", { title: "N" }, 1), add("n1", "n", "Button", { label: "x" })].reduce(applyOp, page);
  expect(ops(page, target, page)).toEqual([
    { type: "add_node", nodeId: "n", parentId: "root", index: 1, component: "Card", props: { title: "N" } },
    { type: "add_node", nodeId: "n1", parentId: "n", index: 0, component: "Button", props: { label: "x" } },
  ]);
});

test("the push replays what the ENGINEER changed on the document as it is now: canvas edits since stay", () => {
  // Since the file was generated, the canvas renamed A, added d and removed c.
  const now = [{ type: "set_prop", nodeId: "a", key: "title", value: "renamed on the canvas" }, add("d", "root", "Button", { label: "D" }), { type: "remove_node", nodeId: "c" }] satisfies Op[];
  const current = now.reduce(applyOp, page);
  // The engineer changed b's label, edited c (gone now) and put a new node first.
  const pushed = [{ type: "set_prop", nodeId: "b", key: "label", value: "from git" }, { type: "set_prop", nodeId: "c", key: "value", value: "edited" }, add("g", "root", "Text", { value: "G" }, 0)] satisfies Op[];
  const result = ops(page, pushed.reduce(applyOp, page), current);
  expect(result).toEqual([
    { type: "add_node", nodeId: "g", parentId: "root", index: 0, component: "Text", props: { value: "G" } },
    { type: "set_prop", nodeId: "b", key: "label", value: "from git" }, // c's edit is dropped: a remove beats a concurrent edit
  ]);
  const after = result.reduce(applyOp, current);
  expect(after.nodes["a"]?.props).toEqual({ title: "renamed on the canvas" });
  expect(after.nodes["root"]?.children).toEqual(["g", "a", "b", "d"]);
});

test("without a base the document is the base: the push is the whole page", () => {
  const target = applyOp(applyOp(page, { type: "remove_node", nodeId: "c" }), { type: "set_prop", nodeId: "b", key: "label", value: "Pay" });
  expect(ops(undefined, target, page)).toEqual([{ type: "set_prop", nodeId: "b", key: "label", value: "Pay" }, { type: "remove_node", nodeId: "c" }]);
  // A base of another page (another root) is no base.
  expect(ops({ rootId: "elsewhere", nodes: {} }, target, page)).toEqual(ops(undefined, target, page));
});

test("an id that was ever part of the page is never added again, and the root must be the document's", () => {
  const readded = applyOp(page, add("old", "root", "Button", { label: "back" }));
  expect(pushOps({ base: page, target: readded, current: page, earlierIds: new Set(["old"]) })).toMatchObject({ ok: false, reason: "reused_node_id" });
  // A new id the document already holds (added on the canvas since the base) is the same mistake.
  const current = applyOp(page, add("old", "root", "Card"));
  expect(pushOps({ base: page, target: readded, current, earlierIds: none })).toMatchObject({ ok: false, reason: "reused_node_id" });
  // An id both sides still hold is no re-use.
  expect(pushOps({ base: page, target: page, current: page, earlierIds: new Set(["a", "b"]) })).toEqual({ ok: true, ops: [] });
  const otherRoot: Doc = { rootId: "r2", nodes: { r2: { id: "r2", component: "Page", props: {}, parentId: null, children: [] } } };
  expect(pushOps({ base: page, target: otherRoot, current: page, earlierIds: none })).toMatchObject({ ok: false, reason: "root_mismatch" });
});

test("for random pages and random edits, the ops rebuild the pushed page exactly, and the same inputs give the same ops", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = seeded(seed);
    let base = emptyDoc();
    for (let i = 0; i < 25; i++) base = applyOp(base, randomOp(random, base));
    let target = base;
    for (let i = 0; i < 12; i++) target = applyOp(target, randomOp(random, target));
    // The generator re-uses ids: a node removed and added again as another component is refused, never patched.
    const changed = Object.keys(target.nodes).some((id) => base.nodes[id] && base.nodes[id].component !== target.nodes[id]?.component);
    if (changed) {
      expect(pushOps({ base, target, current: base, earlierIds: none })).toMatchObject({ ok: false, reason: "component_changed" });
      continue;
    }
    const result = ops(base, target, base);
    expect(shape(result.reduce(applyOp, base)), `seed ${String(seed)}`).toBe(shape(target));
    expect(ops(base, target, base)).toEqual(result);
    expect(ops(target, target, target)).toEqual([]);
  }
});
