import { expect, test } from "vitest";
import { Actor, ClientMessage, ClientOp, PropValue, SequencedOp, ServerMessage } from "./index.ts";

const opId = "11111111-1111-4111-8111-111111111111";
const op = { type: "set_prop", nodeId: "n1", key: "label", value: "Pay" } as const;

test("a peer submits opId, baseSeq and the op, and NOTHING about who it is", () => {
  expect(ClientOp.parse({ opId, baseSeq: 0, op })).toEqual({ opId, baseSeq: 0, op });
  // The actor is stamped by the room from the verified session. A client that sends one is refused,
  // not ignored: silently dropping it would hide a client that believes it can choose its identity.
  const spoof = ClientOp.safeParse({ opId, baseSeq: 0, op, actor: { kind: "user", id: "someone-else" } });
  expect(spoof.success).toBe(false);
});

test("the room's broadcast carries the order and the actor", () => {
  const actor = Actor.parse({ kind: "agent", id: "worker-1", runId: "run-7" });
  expect(SequencedOp.parse({ seq: 1, opId, actor, op })).toMatchObject({ seq: 1, actor: { kind: "agent", runId: "run-7" } });
  expect(SequencedOp.safeParse({ seq: 0, opId, actor, op }).success).toBe(false); // seq starts at 1
  expect(Actor.safeParse({ kind: "admin", id: "x" }).success).toBe(false);
});

test("messages are told apart by `type`, and an unknown or malformed one is refused", () => {
  expect(ClientMessage.parse({ type: "op", opId, baseSeq: 3, op }).type).toBe("op");
  expect(ClientMessage.safeParse({ type: "shutdown" }).success).toBe(false);
  expect(ServerMessage.parse({ type: "rejected", opId, reason: "cycle" }).type).toBe("rejected");
  expect(ServerMessage.parse({ type: "welcome", seq: 0, doc: { rootId: "root", nodes: {} } }).type).toBe("welcome");
});

test("an op with an unknown type, an extra field or a bad id is refused", () => {
  for (const bad of [{ type: "rename_node", nodeId: "n1" }, { ...op, extra: 1 }, { ...op, nodeId: "has spaces" }, { ...op, nodeId: "" }]) {
    expect(ClientOp.safeParse({ opId, baseSeq: 0, op: bad }).success, JSON.stringify(bad)).toBe(false);
  }
});

test("a prop value is a string, a finite number or a boolean, and nothing else", () => {
  for (const ok of ["x", 0, -1.5, true]) expect(PropValue.safeParse(ok).success).toBe(true);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, [], "x".repeat(10_001)]) {
    expect(PropValue.safeParse(bad).success, typeof bad).toBe(false);
  }
});

// --- presence (E2.6): never sequenced, never stored -----------------------------------------------
test("presence from a client: a cursor inside the canvas (fractions 0..1) and a selection, both optional", () => {
  expect(ClientMessage.safeParse({ type: "presence", cursor: { x: 0.25, y: 1 }, selection: "n1" }).success).toBe(true);
  expect(ClientMessage.safeParse({ type: "presence", cursor: null, selection: null }).success).toBe(true);
  for (const bad of [{ x: 1.5, y: 0 }, { x: -0.1, y: 0 }, { x: Number.NaN, y: 0 }, { x: 0 }]) expect(ClientMessage.safeParse({ type: "presence", cursor: bad, selection: null }).success).toBe(false);
  // Who is speaking comes from the connection, never from the message.
  expect(ClientMessage.safeParse({ type: "presence", cursor: null, selection: null, name: "Mallory" }).success).toBe(false);
  expect(ClientMessage.safeParse({ type: "presence", cursor: null, selection: "__proto__" }).success).toBe(false);
});

test("presence from the server names the connection, who it is, and what they point at", () => {
  const entry = { peerId: "p1", actor: { kind: "user", id: "u1" }, name: "Ada", cursor: { x: 0.5, y: 0.5 }, selection: null };
  expect(ServerMessage.safeParse({ type: "presence", ...entry }).success).toBe(true);
  expect(ServerMessage.safeParse({ type: "presence_left", peerId: "p1" }).success).toBe(true);
  expect(ServerMessage.safeParse({ type: "welcome", doc: { rootId: "root", nodes: {} }, seq: 0, you: "p2", peers: [entry] }).success).toBe(true);
  // An older server sends neither: a welcome without them still parses, as "nobody else here".
  expect(ServerMessage.safeParse({ type: "welcome", doc: { rootId: "root", nodes: {} }, seq: 0 }).success).toBe(true);
});
