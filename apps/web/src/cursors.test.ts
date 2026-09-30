import { expect, test } from "vitest";
import { ClientMessage, type Presence, type SequencedOp } from "@noon/contracts";
import { emptyDoc, ROOT_ID } from "@noon/doc-model";
import { aiAnchors, anchorFor, IDLE_AFTER_MS, initialsOf, isIdle, nameOf, summaryOf, tagOf, trackCursors, type Tracked } from "./cursors.ts";
import { toScreen, toWorld, type Viewport } from "./viewport.ts";

const ada: Presence = { peerId: "p1", actor: { kind: "user", id: "u-ada" }, name: "Ada Lovelace", cursor: { x: 120, y: 40 }, selection: null };
const ai: Presence = { peerId: "p2", actor: { kind: "agent", id: "worker-1", runId: "r1" }, name: "", cursor: null, selection: null };
const at = (x: number, y: number): Presence["cursor"] => ({ x, y });

// unit:cursor-world-coords (E10.6)
test("a pointer is sent in WORLD coordinates: two viewports at different zooms and offsets name the same spot on the frame", () => {
  const mine: Viewport = { x: 200, y: 80, zoom: 0.5 };
  const theirs: Viewport = { x: -300, y: 10, zoom: 2.4 };
  // I point at the frame's (240, 100): the middle of a button, say.
  const onMyScreen = toScreen(mine, { x: 240, y: 100 });
  const sent = toWorld(mine, onMyScreen);
  expect(sent.x).toBeCloseTo(240, 9);
  expect(sent.y).toBeCloseTo(100, 9);
  // Drawn on their screen at THEIR zoom, it lands where their button is drawn.
  const drawn = toScreen(theirs, sent);
  expect(drawn).toEqual(toScreen(theirs, { x: 240, y: 100 }));
  // A world point is any point of the infinite sheet: left of or above the frame is a place too, and the wire takes it.
  for (const cursor of [at(-40.5, 1200), at(0, 0), at(960, 600), at(1e5, -1e5)]) expect(ClientMessage.safeParse({ type: "presence", cursor, selection: null }).success, JSON.stringify(cursor)).toBe(true);
  // ...but not a number that is not one, or one that could never be a spot on a page.
  for (const cursor of [{ x: Number.NaN, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }, { x: 1e7, y: 0 }, { x: 0 }, { x: "left", y: 0 }]) expect(ClientMessage.safeParse({ type: "presence", cursor, selection: null }).success, JSON.stringify(cursor)).toBe(false);
});

test("a cursor is tracked with the time it LAST MOVED: a repeat of the same spot keeps it, a new spot resets it, no pointer drops it", () => {
  const first = trackCursors(new Map(), [ada, ai], 1000);
  expect([...first.keys()]).toEqual(["p1"]); // the AI has no pointer
  expect(first.get("p1")).toEqual({ at: { x: 120, y: 40 }, movedAt: 1000 });
  // The peer refreshes its presence every 2 s with the same cursor: that is not a move.
  const refreshed = trackCursors(first, [ada], 3000);
  expect(refreshed.get("p1")?.movedAt).toBe(1000);
  const moved = trackCursors(refreshed, [{ ...ada, cursor: at(121, 40) }], 3500);
  expect(moved.get("p1")).toEqual({ at: { x: 121, y: 40 }, movedAt: 3500 });
  expect(trackCursors(moved, [{ ...ada, cursor: null }], 4000).size).toBe(0);
  expect(trackCursors(moved, [], 4000).size).toBe(0);
});

test("a cursor still for 5 s is idle (and fades); a move brings it back", () => {
  const tracked: Tracked = { at: { x: 0, y: 0 }, movedAt: 10_000 };
  expect(IDLE_AFTER_MS).toBe(5000);
  expect(isIdle(tracked, 10_000 + IDLE_AFTER_MS - 1)).toBe(false);
  expect(isIdle(tracked, 10_000 + IDLE_AFTER_MS)).toBe(true);
  expect(isIdle(trackCursors(new Map([["p1", tracked]]), [{ ...ada, cursor: at(5, 5) }], 20_000).get("p1") ?? tracked, 20_000)).toBe(false);
});

// unit:ai-cursor-follows-last-op (E10.6)
const sequenced = (seq: number, actor: SequencedOp["actor"], op: SequencedOp["op"]): SequencedOp => ({ seq, opId: crypto.randomUUID(), actor, op });
const agent: SequencedOp["actor"] = { kind: "agent", id: "worker-1", runId: "r1" };
const person: SequencedOp["actor"] = { kind: "user", id: "u-ada" };

test("the AI's anchor is the node its last op touched: an add, a move or a prop change moves it there; a person's ops never move it", () => {
  const none = new Map<string, string>();
  let anchors = aiAnchors(none, sequenced(1, agent, { type: "add_node", nodeId: "card", parentId: ROOT_ID, index: 0, component: "Card", props: {} }));
  expect(anchors.get("worker-1")).toBe("card");
  anchors = aiAnchors(anchors, sequenced(2, agent, { type: "add_node", nodeId: "b1", parentId: "card", index: 0, component: "Button", props: { label: "AI 1" } }));
  expect(anchors.get("worker-1")).toBe("b1");
  anchors = aiAnchors(anchors, sequenced(3, agent, { type: "set_prop", nodeId: "card", key: "title", value: "Done" }));
  expect(anchors.get("worker-1")).toBe("card");
  anchors = aiAnchors(anchors, sequenced(4, agent, { type: "move_node", nodeId: "b1", newParentId: ROOT_ID, index: 1 }));
  expect(anchors.get("worker-1")).toBe("b1");
  // Someone else's op: the SAME map comes back, so nothing re-renders for it.
  const before = anchors;
  expect(aiAnchors(anchors, sequenced(5, person, { type: "set_prop", nodeId: "card", key: "title", value: "Mine" }))).toBe(before);
  expect(aiAnchors(anchors, sequenced(6, { kind: "git", id: "git" }, { type: "remove_node", nodeId: "card" }))).toBe(before);
  // Two AI runs are two anchors.
  expect(aiAnchors(anchors, sequenced(7, { kind: "agent", id: "worker-2" }, { type: "add_node", nodeId: "t", parentId: ROOT_ID, index: 0, component: "Text", props: {} })).get("worker-1")).toBe("b1");
});

test("a removal leaves the anchor where it was (the removed node has no box), and an anchor whose node is gone falls back to the page", () => {
  const doc = emptyDoc();
  doc.nodes["card"] = { id: "card", parentId: ROOT_ID, component: "Card", props: {}, children: [] };
  let anchors = aiAnchors(new Map(), sequenced(1, agent, { type: "add_node", nodeId: "card", parentId: ROOT_ID, index: 0, component: "Card", props: {} }));
  anchors = aiAnchors(anchors, sequenced(2, agent, { type: "remove_node", nodeId: "b1" }));
  expect(anchorFor(anchors, "worker-1", doc)).toBe("card");
  delete doc.nodes["card"];
  expect(anchorFor(anchors, "worker-1", doc)).toBe(ROOT_ID);
  // An AI that has arrived but changed nothing yet sits on the page.
  expect(anchorFor(new Map(), "worker-9", doc)).toBe(ROOT_ID);
});

test("what a presence is called: the tag on the cursor is short, the bar says who it is, and the summary reads as a sentence", () => {
  expect(tagOf(ada)).toBe("Ada Lovelace");
  expect(tagOf(ai)).toBe("AI");
  expect(nameOf(ada)).toBe("Ada Lovelace");
  expect(nameOf(ai)).toBe("AI agent");
  expect(nameOf({ ...ada, name: "" })).toBe("user");
  expect(initialsOf("Ada Lovelace")).toBe("AL");
  expect(initialsOf("e2e-123-presence@example.com")).toBe("E");
  expect(initialsOf("AI")).toBe("AI");
  expect(summaryOf([])).toBe("");
  expect(summaryOf([ada, ai])).toBe("Also here: Ada Lovelace, AI agent.");
});
