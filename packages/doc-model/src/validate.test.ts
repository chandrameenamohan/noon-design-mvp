import { expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { applyOp, emptyDoc, ROOT_ID, validate } from "./index.ts";
import { testManifest as manifest } from "./fixtures.ts";

const add = (nodeId: string, parentId: string, component = "Stack", props: Record<string, string | number | boolean> = {}, index = 0): Op => ({ type: "add_node", nodeId, parentId, index, component, props });
const build = (...ops: Op[]): Doc => ops.reduce(applyOp, emptyDoc());
const verdict = (doc: Doc, op: Op) => validate(doc, op, manifest);
const doc = build(add("stack", ROOT_ID), add("inner", "stack"), add("btn", "stack", "Button", { label: "Pay" }));

test("a sensible op is accepted", () => {
  expect(verdict(doc, add("new", "inner", "Button", { label: "Go", disabled: true }))).toEqual({ ok: true });
  expect(verdict(doc, { type: "move_node", nodeId: "btn", newParentId: "inner", index: 0 })).toEqual({ ok: true });
  expect(verdict(doc, { type: "set_prop", nodeId: "stack", key: "direction", value: "row" })).toEqual({ ok: true });
  expect(verdict(doc, { type: "set_prop", nodeId: "stack", key: "gap", value: null })).toEqual({ ok: true }); // back to the default
  expect(verdict(doc, { type: "remove_node", nodeId: "inner" })).toEqual({ ok: true });
});

test.each<[string, Op, string]>([
  ["a move into its own subtree", { type: "move_node", nodeId: "stack", newParentId: "inner", index: 0 }, "cycle"],
  ["a move onto itself", { type: "move_node", nodeId: "stack", newParentId: "stack", index: 0 }, "cycle"],
  ["a component the design system does not have", add("x", ROOT_ID, "Carousel"), "unknown_component"],
  ["the reserved root component", add("x", ROOT_ID, "Page"), "unknown_component"],
  ["a prop the component does not have", add("x", ROOT_ID, "Button", { label: "ok", colour: "red" }), "unknown_prop"],
  ["a prop of the wrong type", add("x", ROOT_ID, "Button", { label: 42 }), "wrong_prop_type"],
  ["an enum value outside its options", { type: "set_prop", nodeId: "stack", key: "direction", value: "diagonal" }, "wrong_prop_type"],
  ["a missing required prop", add("x", ROOT_ID, "Button"), "missing_required_prop"],
  ["unsetting a required prop", { type: "set_prop", nodeId: "btn", key: "label", value: null }, "missing_required_prop"],
  ["a child under a component that takes none", add("x", "btn"), "parent_takes_no_children"],
  ["a move under a component that takes none", { type: "move_node", nodeId: "inner", newParentId: "btn", index: 0 }, "parent_takes_no_children"],
  ["an id that is already in use", add("stack", ROOT_ID), "duplicate_node"],
  ["removing the root", { type: "remove_node", nodeId: ROOT_ID }, "root_is_fixed"],
  ["moving the root", { type: "move_node", nodeId: ROOT_ID, newParentId: "stack", index: 0 }, "root_is_fixed"],
  ["a prop on the root", { type: "set_prop", nodeId: ROOT_ID, key: "gap", value: 1 }, "root_is_fixed"],
])("%s is rejected as %s", (_label, op, reason) => {
  expect(verdict(doc, op)).toEqual({ ok: false, reason });
});

test("remove beats a concurrent edit: ops on a removed node or its descendants are 'gone'", () => {
  const after = applyOp(doc, { type: "remove_node", nodeId: "stack" }); // takes inner and btn with it
  for (const op of [
    { type: "set_prop", nodeId: "btn", key: "label", value: "late" },
    { type: "set_prop", nodeId: "stack", key: "gap", value: 4 },
    { type: "move_node", nodeId: "inner", newParentId: ROOT_ID, index: 0 },
    { type: "remove_node", nodeId: "inner" },
  ] satisfies Op[]) {
    expect(verdict(after, op), JSON.stringify(op)).toEqual({ ok: false, reason: "gone" });
    expect(applyOp(after, op)).toBe(after);
  }
});

test("an add or move under a concurrently removed parent is 'gone' too (an orphan is never created)", () => {
  const after = applyOp(doc, { type: "remove_node", nodeId: "inner" });
  expect(verdict(after, add("orphan", "inner"))).toEqual({ ok: false, reason: "gone" });
  expect(verdict(after, { type: "move_node", nodeId: "btn", newParentId: "inner", index: 0 })).toEqual({ ok: false, reason: "gone" });
  expect(applyOp(after, add("orphan", "inner")).nodes["orphan"]).toBeUndefined();
});

test("any integer index is valid, because applyOp clamps it", () => {
  for (const index of [-100, 0, 1, 9999]) {
    const op = add(`i${String(index + 100)}`, "stack", "Stack", {}, index);
    expect(verdict(doc, op)).toEqual({ ok: true });
    const kids = applyOp(doc, op).nodes["stack"]?.children ?? [];
    expect(kids).toHaveLength(3);
    expect(kids.indexOf(op.type === "add_node" ? op.nodeId : "")).toBe(Math.max(0, Math.min(index, 2)));
  }
});

test("'gone' is the one reason a client must not show: the node vanished, the user did nothing wrong", () => {
  const reasons = new Set<string>();
  const after = applyOp(doc, { type: "remove_node", nodeId: "stack" });
  const r = verdict(after, { type: "set_prop", nodeId: "btn", key: "label", value: "x" });
  if (!r.ok) reasons.add(r.reason);
  expect([...reasons]).toEqual(["gone"]);
});

test("a move on a document that already contains a cycle still gets an answer (it used to loop for ever)", () => {
  const doc = emptyDoc();
  const loop = { component: "Stack", props: {}, children: [] };
  doc.nodes["a"] = { ...loop, id: "a", parentId: "b" };
  doc.nodes["b"] = { ...loop, id: "b", parentId: "a" };
  doc.nodes["x"] = { ...loop, id: "x", parentId: ROOT_ID };
  expect(verdict(doc, { type: "move_node", nodeId: "x", newParentId: "a", index: 0 }).ok).toBe(true);
});
