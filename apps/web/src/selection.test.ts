import { expect, test } from "vitest";
import type { Doc } from "@noon/contracts";
import { hitTest, step, type Box } from "./selection.ts";

// unit:hit-test (E10.2)

// The page frame holds a card; the card holds a button and a text side by side.
const boxes: Box[] = [
  { id: "root", depth: 0, left: 0, top: 0, right: 960, bottom: 600 },
  { id: "card", depth: 1, left: 24, top: 24, right: 936, bottom: 200 },
  { id: "button", depth: 2, left: 40, top: 40, right: 140, bottom: 80 },
  { id: "text", depth: 2, left: 148, top: 40, right: 400, bottom: 80 },
];

test("the deepest node under the point wins, whatever the order of the boxes", () => {
  expect(hitTest(boxes, { x: 50, y: 50 })).toBe("button");
  expect(hitTest([...boxes].reverse(), { x: 50, y: 50 })).toBe("button");
  expect(hitTest(boxes, { x: 200, y: 60 })).toBe("text");
  expect(hitTest(boxes, { x: 500, y: 150 })).toBe("card"); // inside the card, beside its children
  expect(hitTest(boxes, { x: 500, y: 400 })).toBe("root"); // the page, below the card
});

test("nothing under the point is null, and edges belong to the box on their inside only", () => {
  expect(hitTest(boxes, { x: -1, y: 10 })).toBeNull();
  expect(hitTest(boxes, { x: 960, y: 10 })).toBeNull(); // the right edge is exclusive
  expect(hitTest(boxes, { x: 0, y: 0 })).toBe("root"); // the top-left corner is inclusive
  expect(hitTest([], { x: 1, y: 1 })).toBeNull();
});

test("siblings that overlap: the one drawn last (later in document order) wins", () => {
  const overlapping: Box[] = [...boxes, { id: "text-over", depth: 2, left: 100, top: 40, right: 200, bottom: 80 }];
  expect(hitTest(overlapping, { x: 120, y: 60 })).toBe("text-over");
  // A deeper node beats a later shallow one all the same.
  expect(hitTest([...boxes, { id: "late-card", depth: 1, left: 0, top: 0, right: 960, bottom: 600 }], { x: 50, y: 50 })).toBe("button");
});

// --- keyboard steps -------------------------------------------------------------------------------
const doc: Doc = {
  rootId: "root",
  nodes: {
    root: { id: "root", component: "Page", props: {}, parentId: null, children: ["card", "text2"] },
    card: { id: "card", component: "Card", props: {}, parentId: "root", children: ["button", "text"] },
    button: { id: "button", component: "Button", props: { label: "Go" }, parentId: "card", children: [] },
    text: { id: "text", component: "Text", props: { value: "Hi" }, parentId: "card", children: [] },
    text2: { id: "text2", component: "Text", props: { value: "Bye" }, parentId: "root", children: [] },
  },
};

test("arrows walk siblings and stop at the ends; Enter goes in, Shift+Enter comes out", () => {
  expect(step(doc, "button", "next")).toBe("text");
  expect(step(doc, "text", "previous")).toBe("button");
  expect(step(doc, "text", "next")).toBe("text"); // the last sibling stays
  expect(step(doc, "button", "previous")).toBe("button"); // so does the first
  expect(step(doc, "root", "in")).toBe("card");
  expect(step(doc, "card", "in")).toBe("button");
  expect(step(doc, "button", "in")).toBe("button"); // a leaf has nothing to go into
  expect(step(doc, "button", "out")).toBe("card");
  expect(step(doc, "card", "out")).toBe("root");
  expect(step(doc, "root", "out")).toBe("root");
  expect(step(doc, "root", "next")).toBe("root"); // the page has no siblings
});

test("a selection that no longer exists (removed by someone else) steps to the page", () => {
  expect(step(doc, "gone", "next")).toBe("root");
  expect(step(doc, "gone", "in")).toBe("root");
});
