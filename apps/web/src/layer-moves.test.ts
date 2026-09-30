import { expect, test } from "vitest";
import type { Doc } from "@noon/contracts";
import { doc } from "./doc.fixture.ts";
import { dropToMoveOp, keyMoveOp, placementAt, visibleRows, type Row } from "./layer-moves.ts";

// unit:drop-to-move-op (E10.3): a drop intent becomes ONE move_node, or null when there is nowhere to go.
// The page (doc.fixture.ts) holds a card (with a button and a text), a stack (empty) and a second text.

test("before and after a row mean that row's parent, at the row's place or the one past it", () => {
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "card", placement: "before" })).toEqual({ type: "move_node", nodeId: "text2", newParentId: "root", index: 0 });
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "button", placement: "after" })).toEqual({ type: "move_node", nodeId: "text2", newParentId: "card", index: 1 });
  expect(dropToMoveOp(doc, { nodeId: "button", targetId: "stack", placement: "before" })).toEqual({ type: "move_node", nodeId: "button", newParentId: "root", index: 1 });
});

test("into a row means that row, at the end of its children", () => {
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "card", placement: "into" })).toEqual({ type: "move_node", nodeId: "text2", newParentId: "card", index: 2 });
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "stack", placement: "into" })).toEqual({ type: "move_node", nodeId: "text2", newParentId: "stack", index: 0 });
  // Already inside: the end is counted without it.
  expect(dropToMoveOp(doc, { nodeId: "button", targetId: "card", placement: "into" })).toEqual({ type: "move_node", nodeId: "button", newParentId: "card", index: 1 });
});

test("within one parent the index is the node's FINAL place, counted after it was taken out", () => {
  // [card, stack, text2]: card after stack -> [stack, card, text2] = index 1, not 2.
  expect(dropToMoveOp(doc, { nodeId: "card", targetId: "stack", placement: "after" })).toEqual({ type: "move_node", nodeId: "card", newParentId: "root", index: 1 });
  // text2 before stack -> [card, text2, stack] = index 1.
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "stack", placement: "before" })).toEqual({ type: "move_node", nodeId: "text2", newParentId: "root", index: 1 });
  // card before stack: where it already is. The op is still built; the replica sees it changes nothing.
  expect(dropToMoveOp(doc, { nodeId: "card", targetId: "stack", placement: "before" })).toEqual({ type: "move_node", nodeId: "card", newParentId: "root", index: 0 });
});

test("a drop onto itself, into its own subtree, or beside the page has nowhere to go: null", () => {
  expect(dropToMoveOp(doc, { nodeId: "card", targetId: "card", placement: "into" })).toBeNull();
  expect(dropToMoveOp(doc, { nodeId: "card", targetId: "card", placement: "after" })).toBeNull();
  expect(dropToMoveOp(doc, { nodeId: "card", targetId: "button", placement: "before" })).toBeNull(); // beside its own child
  expect(dropToMoveOp(doc, { nodeId: "card", targetId: "text", placement: "into" })).toBeNull();
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "root", placement: "before" })).toBeNull();
  expect(dropToMoveOp(doc, { nodeId: "root", targetId: "card", placement: "into" })).toBeNull(); // the page does not move
  expect(dropToMoveOp(doc, { nodeId: "gone", targetId: "card", placement: "into" })).toBeNull();
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "gone", placement: "into" })).toBeNull();
});

test("it does not predict the room: into a node that takes no children is still built, and refused there", () => {
  expect(dropToMoveOp(doc, { nodeId: "text2", targetId: "button", placement: "into" })).toEqual({ type: "move_node", nodeId: "text2", newParentId: "button", index: 0 });
});

test("a cycle in the document itself (never checked by anyone) ends the walk instead of hanging the tab", () => {
  const cyclic: Doc = { rootId: "root", nodes: { ...doc.nodes, a: { id: "a", component: "Card", props: {}, parentId: "b", children: ["b"] }, b: { id: "b", component: "Card", props: {}, parentId: "a", children: ["a"] } } };
  expect(dropToMoveOp(cyclic, { nodeId: "text2", targetId: "a", placement: "into" })).toEqual({ type: "move_node", nodeId: "text2", newParentId: "a", index: 1 });
});

// --- where on a row the pointer is ---------------------------------------------------------------
test("a container's middle half is into; a row that takes no children has only a top and a bottom half", () => {
  expect(placementAt(0.1, true)).toBe("before");
  expect(placementAt(0.5, true)).toBe("into");
  expect(placementAt(0.25, true)).toBe("into");
  expect(placementAt(0.75, true)).toBe("after");
  expect(placementAt(0.9, true)).toBe("after");
  expect(placementAt(0.3, false)).toBe("before");
  expect(placementAt(0.5, false)).toBe("after");
});

// --- the keyboard's moves ------------------------------------------------------------------------
test("Alt+Up and Alt+Down swap with a neighbour and do nothing at the ends", () => {
  expect(keyMoveOp(doc, "stack", "up")).toEqual({ type: "move_node", nodeId: "stack", newParentId: "root", index: 0 });
  expect(keyMoveOp(doc, "stack", "down")).toEqual({ type: "move_node", nodeId: "stack", newParentId: "root", index: 2 });
  expect(keyMoveOp(doc, "card", "up")).toBeNull();
  expect(keyMoveOp(doc, "text2", "down")).toBeNull();
  expect(keyMoveOp(doc, "root", "down")).toBeNull();
});

test("Alt+Right nests into the previous sibling; Alt+Left steps out to just after the parent", () => {
  expect(keyMoveOp(doc, "stack", "nest")).toEqual({ type: "move_node", nodeId: "stack", newParentId: "card", index: 2 });
  expect(keyMoveOp(doc, "card", "nest")).toBeNull(); // nothing before it
  // The previous sibling is a button: the op is built all the same, and the room says it takes no children.
  expect(keyMoveOp(doc, "text", "nest")).toEqual({ type: "move_node", nodeId: "text", newParentId: "button", index: 0 });
  expect(keyMoveOp(doc, "button", "outdent")).toEqual({ type: "move_node", nodeId: "button", newParentId: "root", index: 1 });
  expect(keyMoveOp(doc, "card", "outdent")).toBeNull(); // already on the page
});

// --- collapsing -----------------------------------------------------------------------------------
const rows: Row[] = [
  { id: "root", label: "Page", depth: 0 },
  { id: "card", label: "Card 1", depth: 1 },
  { id: "button", label: "Button 1", depth: 2 },
  { id: "text", label: "Text 1", depth: 2 },
  { id: "stack", label: "Stack 1", depth: 1 },
  { id: "text2", label: "Text 2", depth: 1 },
];

test("a collapsed row hides everything under it, however deep, and nothing beside or after it", () => {
  expect(visibleRows(rows, new Set()).map((r) => r.id)).toEqual(["root", "card", "button", "text", "stack", "text2"]);
  expect(visibleRows(rows, new Set(["card"])).map((r) => r.id)).toEqual(["root", "card", "stack", "text2"]);
  expect(visibleRows(rows, new Set(["root"])).map((r) => r.id)).toEqual(["root"]);
  // A collapsed row that is itself hidden changes nothing.
  expect(visibleRows(rows, new Set(["card", "button"])).map((r) => r.id)).toEqual(["root", "card", "stack", "text2"]);
});
