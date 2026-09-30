import { expect, test } from "vitest";
import type { Manifest } from "@noon/contracts";
import { doc } from "./doc.fixture.ts";
import { addOpAt, indexAlong, insertLineAt, previewProps, requiredProps, slotForDrop, slotForSelection, slotOnCanvas } from "./library-adds.ts";

// unit:drop-to-add-op (E10.5): a drop target (a row and a place, a node under the pointer, the selection) becomes
// ONE slot (parentId + index), and the slot becomes ONE add_node with the manifest's required props.
// The page (doc.fixture.ts) holds a card (with a button and a text), a stack (empty) and a second text.
const CONTAINERS = new Set(["root", "card", "stack"]);
const isContainer = (id: string): boolean => CONTAINERS.has(id);

type Component = Manifest["components"][number];
const button: Component = {
  name: "Button",
  acceptsChildren: false,
  props: [
    { name: "label", type: { kind: "string" }, required: true },
    { name: "variant", type: { kind: "enum", options: ["ghost", "primary"] }, required: false, default: "primary" },
    { name: "disabled", type: { kind: "boolean" }, required: false, default: false },
  ],
};
const odd: Component = {
  name: "Odd",
  acceptsChildren: true,
  props: [
    { name: "count", type: { kind: "number" }, required: true },
    { name: "on", type: { kind: "boolean" }, required: true },
    { name: "kind", type: { kind: "enum", options: ["a", "b"] }, required: true },
    { name: "src", type: { kind: "string" }, required: true },
  ],
};

// --- the tree: a row and a place, as the layers' own drag reads them ------------------------------------
test("before and after a row mean that row's parent at the row's place or the one past it; into means the row, at the end", () => {
  expect(slotForDrop(doc, { targetId: "stack", placement: "before" })).toEqual({ parentId: "root", index: 1 });
  expect(slotForDrop(doc, { targetId: "stack", placement: "after" })).toEqual({ parentId: "root", index: 2 });
  expect(slotForDrop(doc, { targetId: "button", placement: "after" })).toEqual({ parentId: "card", index: 1 });
  expect(slotForDrop(doc, { targetId: "card", placement: "into" })).toEqual({ parentId: "card", index: 2 });
  expect(slotForDrop(doc, { targetId: "stack", placement: "into" })).toEqual({ parentId: "stack", index: 0 });
  expect(slotForDrop(doc, { targetId: "root", placement: "into" })).toEqual({ parentId: "root", index: 3 });
});

test("beside the page, or onto a node that is gone, there is no slot", () => {
  expect(slotForDrop(doc, { targetId: "root", placement: "before" })).toBeNull();
  expect(slotForDrop(doc, { targetId: "root", placement: "after" })).toBeNull();
  expect(slotForDrop(doc, { targetId: "gone", placement: "into" })).toBeNull();
});

test("it does not predict the room: into a node that takes no children is still a slot, and refused there", () => {
  expect(slotForDrop(doc, { targetId: "button", placement: "into" })).toEqual({ parentId: "button", index: 0 });
});

// --- the canvas: the node under the pointer -------------------------------------------------------------
test("over a container the component goes into it at the index the pointer says; over a leaf, after the leaf in its parent; over nothing, onto the page", () => {
  expect(slotOnCanvas(doc, "card", isContainer, () => 1)).toEqual({ parentId: "card", index: 1 });
  expect(slotOnCanvas(doc, "stack", isContainer, () => 0)).toEqual({ parentId: "stack", index: 0 });
  expect(slotOnCanvas(doc, "button", isContainer, () => 99)).toEqual({ parentId: "card", index: 1 });
  expect(slotOnCanvas(doc, "text2", isContainer, () => 99)).toEqual({ parentId: "root", index: 3 });
  expect(slotOnCanvas(doc, null, isContainer, () => 7)).toEqual({ parentId: "root", index: 7 });
  expect(slotOnCanvas(doc, "gone", isContainer, () => 0)).toBeNull();
});

test("the index among children is how many of them the pointer has passed the middle of, along the layout axis", () => {
  const children = [{ start: 0, end: 40 }, { start: 48, end: 88 }, { start: 96, end: 136 }];
  expect(indexAlong(children, -5)).toBe(0);
  expect(indexAlong(children, 19)).toBe(0);
  expect(indexAlong(children, 21)).toBe(1); // past the first one's middle
  expect(indexAlong(children, 92)).toBe(2); // in the gap between the second and the third
  expect(indexAlong(children, 500)).toBe(3);
  expect(indexAlong([], 10)).toBe(0);
});

test("the drop line sits at the start of the child at the index, between two children in the middle of their gap, after the last one, or at the top of an empty box", () => {
  const inner = { left: 10, top: 20, right: 210, bottom: 320 };
  const column = [{ left: 10, top: 20, right: 210, bottom: 60 }, { left: 10, top: 68, right: 210, bottom: 108 }];
  expect(insertLineAt(inner, column, "y", 0)).toEqual({ left: 10, top: 20, right: 210, bottom: 20 });
  expect(insertLineAt(inner, column, "y", 1)).toEqual({ left: 10, top: 64, right: 210, bottom: 64 });
  expect(insertLineAt(inner, column, "y", 2)).toEqual({ left: 10, top: 108, right: 210, bottom: 108 });
  expect(insertLineAt(inner, [], "y", 0)).toEqual({ left: 10, top: 20, right: 210, bottom: 20 });
  // A row lays its children out along x: the line is vertical, the full inner height.
  const row = [{ left: 10, top: 20, right: 50, bottom: 60 }, { left: 58, top: 20, right: 98, bottom: 60 }];
  expect(insertLineAt(inner, row, "x", 1)).toEqual({ left: 54, top: 20, right: 54, bottom: 320 });
  expect(insertLineAt(inner, row, "x", 2)).toEqual({ left: 98, top: 20, right: 98, bottom: 320 });
  // An index past the end (a child left meanwhile) is the end.
  expect(insertLineAt(inner, row, "x", 9)).toEqual({ left: 98, top: 20, right: 98, bottom: 320 });
});

// --- the keyboard and a click: the selection ------------------------------------------------------------
test("Enter adds into the selected container at the end, after a selected leaf, and onto the page when nothing sensible is selected", () => {
  expect(slotForSelection(doc, "card", isContainer)).toEqual({ parentId: "card", index: 2 });
  expect(slotForSelection(doc, "root", isContainer)).toEqual({ parentId: "root", index: 3 });
  expect(slotForSelection(doc, "button", isContainer)).toEqual({ parentId: "card", index: 1 });
  expect(slotForSelection(doc, "text2", isContainer)).toEqual({ parentId: "root", index: 3 });
  expect(slotForSelection(doc, "gone", isContainer)).toEqual({ parentId: "root", index: 3 });
});

// --- the op --------------------------------------------------------------------------------------------
test("the op carries the slot, the id minted by the caller, and ONLY the required props, each with a value of its kind", () => {
  expect(addOpAt({ parentId: "card", index: 1 }, button, "new-1")).toEqual({ type: "add_node", nodeId: "new-1", parentId: "card", index: 1, component: "Button", props: { label: "Button" } });
  expect(requiredProps(odd)).toEqual({ count: 0, on: false, kind: "a", src: "Odd" });
  expect(requiredProps({ name: "Bare", acceptsChildren: true, props: [] })).toEqual({});
});

test("the thumbnail's props are the required ones, except that a src is an inline image: a name is not an address, and a failed request is a console error", () => {
  const props = previewProps(odd);
  expect(props["count"]).toBe(0);
  expect(String(props["src"])).toMatch(/^data:image\/svg\+xml/u);
  expect(previewProps(button)).toEqual({ label: "Button" });
});
