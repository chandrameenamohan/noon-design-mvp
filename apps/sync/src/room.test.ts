import { expect, test } from "vitest";
import type { Actor, ClientOp, Manifest, Op, SequencedOp, ServerMessage } from "@noon/contracts";
import { emptyDoc, ROOT_ID } from "@noon/doc-model";
import { createRoom, type Peer } from "./room.ts";

// The room is pure logic, so its rules are tested here without sockets. Each test below reproduces a
// finding from the E2.3 review.

const manifest: Manifest = { version: 1, components: [{ name: "Stack", acceptsChildren: true, props: [{ name: "gap", type: { kind: "number" }, required: false }] }] };
let nextId = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
const add = (nodeId: string, parentId = ROOT_ID): Op => ({ type: "add_node", nodeId, parentId, index: 99, component: "Stack", props: {} });
const clientOp = (op: Op, baseSeq = 0, opId = uuid()): ClientOp => ({ opId, baseSeq, op });

function peer(id: string, kind: Actor["kind"] = "user"): Peer & { inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  return { actor: { kind, id }, session: { userId: id, orgId: "org", expiresAt: 0 }, inbox, send: (m) => void inbox.push(m) };
}
const ops = (p: { inbox: ServerMessage[] }) => p.inbox.filter((m): m is Extract<ServerMessage, { type: "op" }> => m.type === "op");
const rejects = (p: { inbox: ServerMessage[] }) => p.inbox.filter((m): m is Extract<ServerMessage, { type: "rejected" }> => m.type === "rejected");

test("the welcome carries a COPY of the document: later ops must not change a message already handed out", async () => {
  const room = createRoom({ doc: emptyDoc(), manifest });
  const a = peer("a");
  room.join(a);
  const welcomed = a.inbox[0];
  await room.submit(a, clientOp(add("n1")));
  expect(welcomed).toEqual({ type: "welcome", doc: emptyDoc(), seq: 0 });
});

test("dedupe is per SENDER: a peer that replays an opId it saw in a broadcast gets its own op handled, not the other peer's answer", async () => {
  const room = createRoom({ doc: emptyDoc(), manifest });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  const first = clientOp(add("from-a"));
  await room.submit(a, first);
  await room.submit(b, { ...clientOp(add("from-b")), opId: first.opId }); // same opId, different sender and op
  expect(ops(b).map((m) => [m.seq, m.actor.id, m.op.type === "add_node" ? m.op.nodeId : ""])).toEqual([[1, "a", "from-a"], [2, "b", "from-b"]]);
  expect(room.doc.nodes["from-b"]).toBeDefined(); // b's edit was not silently discarded
});

test("an op that was already applied is never applied twice, even when it is resent after it fell out of the dedupe window", async () => {
  const room = createRoom({ doc: emptyDoc(), manifest, limits: { rememberedOps: 3 } });
  const a = peer("a");
  room.join(a);
  await room.submit(a, clientOp(add("p1")));
  await room.submit(a, clientOp(add("p2")));
  await room.submit(a, clientOp(add("x", "p1")));
  const move = clientOp({ type: "move_node", nodeId: "x", newParentId: "p2", index: 0 }, 3);
  await room.submit(a, move); // seq 4
  for (const id of ["f1", "f2", "f3", "f4"]) await room.submit(a, clientOp(add(id), 4)); // pushes `move` out of the window
  await room.submit(a, clientOp({ type: "move_node", nodeId: "x", newParentId: "p1", index: 0 }, 8)); // a teammate moves it back: seq 9

  await room.submit(a, move); // the resend a reconnecting client makes: its baseSeq (3) is older than anything remembered
  expect(rejects(a).at(-1)).toEqual({ type: "rejected", opId: move.opId, reason: "stale" });
  expect(room.doc.nodes["x"]?.parentId).toBe("p1"); // NOT moved a second time
  expect(ops(a).filter((m) => m.opId === move.opId)).toHaveLength(1); // one opId, one seq, ever

  const recent = clientOp(add("recent"), 9);
  await room.submit(a, recent);
  await room.submit(a, recent);
  expect(ops(a).filter((m) => m.opId === recent.opId).map((m) => m.seq)).toEqual([10, 10]); // inside the window: original seq again
});

test("depth is capped for moves too, and 'maxDepth' means what it says", async () => {
  const room = createRoom({ doc: emptyDoc(), manifest, limits: { maxDepth: 3 } });
  const a = peer("a");
  room.join(a);
  for (const [id, parent] of [["a1", ROOT_ID], ["a2", "a1"], ["a3", "a2"], ["c1", ROOT_ID], ["c2", "c1"]] as const) await room.submit(a, clientOp(add(id, parent)));
  expect(ops(a)).toHaveLength(5); // a3 sits at depth 3 = maxDepth: allowed
  await room.submit(a, clientOp(add("a4", "a3")));
  expect(rejects(a).at(-1)?.reason).toBe("document_limit"); // depth 4
  await room.submit(a, clientOp({ type: "move_node", nodeId: "c1", newParentId: "a2", index: 0 })); // c2 would land at depth 4
  expect(rejects(a).at(-1)?.reason).toBe("document_limit");
  await room.submit(a, clientOp({ type: "move_node", nodeId: "c2", newParentId: "a2", index: 0 })); // depth 3: fine
  expect(room.doc.nodes["c2"]?.parentId).toBe("a2");
});

test("ops wait their turn: with a slow persist step, order, dedupe and numbering still hold", async () => {
  const persisted: number[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const room = createRoom({ doc: emptyDoc(), manifest, persist: async (op: SequencedOp) => { await gate; persisted.push(op.seq); } });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  const one = clientOp(add("same-id"));
  const all = Promise.all([room.submit(a, one), room.submit(b, clientOp(add("same-id"))), room.submit(a, one)]); // a race on one node id, plus a resend in flight
  expect(ops(a)).toHaveLength(0); // nothing is broadcast before it is persisted
  release();
  await all;
  expect(persisted).toEqual([1]); // b's duplicate was judged AFTER a's op landed, so it never took a number
  expect(rejects(b).map((r) => r.reason)).toEqual(["duplicate_node"]);
  expect(ops(a).map((m) => m.seq)).toEqual([1, 1]); // the op, then the answer to its resend
});

test("if an op cannot be persisted nobody receives it, the document is untouched, and its number is not used up", async () => {
  let fail = true;
  const room = createRoom({ doc: emptyDoc(), manifest, persist: () => (fail ? Promise.reject(new Error("journal down")) : Promise.resolve()) });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  const op = clientOp(add("n1"));
  await room.submit(a, op);
  expect(rejects(a)).toEqual([{ type: "rejected", opId: op.opId, reason: "unavailable" }]);
  expect(ops(b)).toEqual([]);
  expect(room.doc.nodes["n1"]).toBeUndefined();
  fail = false;
  await room.submit(a, op); // the client retries the same op
  expect(ops(b).map((m) => m.seq)).toEqual([1]); // no gap in the numbering
});

test("the room knows who is in it, for presence and for cutting off a revoked user", () => {
  const room = createRoom({ doc: emptyDoc(), manifest });
  const [a, b] = [peer("alice"), peer("bob")];
  room.join(a); room.join(b);
  expect([...room.peers].map((p) => p.session.userId).sort()).toEqual(["alice", "bob"]);
  room.leave(a);
  expect(room.peerCount).toBe(1);
});
