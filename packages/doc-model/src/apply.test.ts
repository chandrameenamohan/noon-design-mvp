import { expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { applyOp, checkDoc, emptyDoc, ROOT_ID } from "./index.ts";

const add = (nodeId: string, parentId: string, index = 0, component = "Stack"): Op => ({ type: "add_node", nodeId, parentId, index, component, props: {} });
const build = (...ops: Op[]): Doc => ops.reduce(applyOp, emptyDoc());
const kids = (doc: Doc, id: string): string[] => doc.nodes[id]?.children ?? [];

/** Freezes every level, so any in-place mutation throws instead of passing unnoticed. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

test("an empty document is just a root that accepts children", () => {
  const doc = emptyDoc();
  expect(doc.nodes[ROOT_ID]).toEqual({ id: ROOT_ID, component: "Page", props: {}, parentId: null, children: [] });
  expect(checkDoc(doc)).toEqual([]);
});

test("add_node inserts at the index, and an index outside the range clamps", () => {
  const doc = build(add("a", ROOT_ID), add("b", ROOT_ID, 0), add("c", ROOT_ID, 99), add("d", ROOT_ID, -5));
  expect(kids(doc, ROOT_ID)).toEqual(["d", "b", "a", "c"]);
  expect(doc.nodes["a"]).toMatchObject({ parentId: ROOT_ID, component: "Stack", children: [] });
});

test("an op that cannot apply leaves the document untouched (the SAME object)", () => {
  const doc = build(add("a", ROOT_ID));
  for (const op of [
    add("x", "missing-parent"),
    add("a", ROOT_ID), // the id already exists
    { type: "move_node", nodeId: "ghost", newParentId: ROOT_ID, index: 0 },
    { type: "move_node", nodeId: "a", newParentId: "ghost", index: 0 },
    { type: "remove_node", nodeId: "ghost" },
    { type: "remove_node", nodeId: ROOT_ID },
    { type: "move_node", nodeId: ROOT_ID, newParentId: "a", index: 0 },
    { type: "set_prop", nodeId: "ghost", key: "gap", value: 8 },
  ] satisfies Op[]) {
    expect(applyOp(doc, op), JSON.stringify(op)).toBe(doc);
  }
});

test("move_node reorders inside a parent and moves between parents", () => {
  const doc = build(add("a", ROOT_ID, 0), add("b", ROOT_ID, 1), add("c", ROOT_ID, 2), add("inner", "a"));
  const reordered = applyOp(doc, { type: "move_node", nodeId: "c", newParentId: ROOT_ID, index: 0 });
  expect(kids(reordered, ROOT_ID)).toEqual(["c", "a", "b"]);
  const adopted = applyOp(doc, { type: "move_node", nodeId: "b", newParentId: "a", index: 0 });
  expect(kids(adopted, ROOT_ID)).toEqual(["a", "c"]);
  expect(kids(adopted, "a")).toEqual(["b", "inner"]);
  expect(adopted.nodes["b"]?.parentId).toBe("a");
});

test("a move that would create a cycle does nothing", () => {
  const doc = build(add("a", ROOT_ID), add("b", "a"), add("c", "b"));
  expect(applyOp(doc, { type: "move_node", nodeId: "a", newParentId: "c", index: 0 })).toBe(doc);
  expect(applyOp(doc, { type: "move_node", nodeId: "a", newParentId: "a", index: 0 })).toBe(doc);
});

test("remove_node takes the whole subtree, and later ops on anything inside it do nothing", () => {
  const doc = build(add("a", ROOT_ID), add("b", "a"), add("c", "b"), add("keep", ROOT_ID, 1));
  const removed = applyOp(doc, { type: "remove_node", nodeId: "a" });
  expect(Object.keys(removed.nodes).sort()).toEqual(["keep", ROOT_ID].sort());
  expect(kids(removed, ROOT_ID)).toEqual(["keep"]);
  expect(applyOp(removed, { type: "set_prop", nodeId: "c", key: "gap", value: 1 })).toBe(removed);
  expect(applyOp(removed, add("late", "b"))).toBe(removed);
});

test("set_prop sets a value, and null removes the key so the component's default applies again", () => {
  const doc = build(add("a", ROOT_ID));
  const set = applyOp(doc, { type: "set_prop", nodeId: "a", key: "gap", value: 16 });
  expect(set.nodes["a"]?.props).toEqual({ gap: 16 });
  expect(applyOp(set, { type: "set_prop", nodeId: "a", key: "gap", value: null }).nodes["a"]?.props).toEqual({});
});

test("applyOp never mutates its input", () => {
  const doc = deepFreeze(build(add("a", ROOT_ID), add("b", "a")));
  const ops: Op[] = [add("c", "a"), { type: "move_node", nodeId: "b", newParentId: ROOT_ID, index: 0 }, { type: "set_prop", nodeId: "a", key: "gap", value: 4 }, { type: "remove_node", nodeId: "a" }];
  for (const op of ops) expect(() => applyOp(doc, op)).not.toThrow();
});
