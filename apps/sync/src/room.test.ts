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

// --- E2.9: a budget per peer, and ops that change nothing ---------------------------------------
const setGap = (nodeId: string, value: number): Op => ({ type: "set_prop", nodeId, key: "gap", value });
/** A room whose clock the test moves by hand. */
function timedRoom(rate: { perSecond: number; burst: number; maxStrikes?: number }) {
  const clock = { now: 0 };
  return { clock, room: createRoom({ doc: emptyDoc(), manifest, rate, now: () => clock.now }) };
}

test("rate limit: a peer may spend its burst, then is refused with a hint of when to come back", async () => {
  const { room } = timedRoom({ perSecond: 10, burst: 3 });
  const a = peer("a");
  room.join(a);
  for (const id of ["n1", "n2", "n3", "n4"]) await room.submit(a, clientOp(add(id)));
  expect(ops(a)).toHaveLength(3);
  expect(rejects(a)).toEqual([{ type: "rejected", opId: expect.any(String) as string, reason: "rate_limited", retryAfterMs: 100 }]);
  expect(room.seq).toBe(3); // a refused op takes no sequence number
});

test("rate limit: the budget refills with time, and one peer's flood does not spend another peer's budget", async () => {
  const { room, clock } = timedRoom({ perSecond: 10, burst: 2 });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  for (const id of ["a1", "a2", "a3"]) await room.submit(a, clientOp(add(id)));
  await room.submit(b, clientOp(add("b1")));
  expect(room.doc.nodes["b1"]).toBeDefined();
  clock.now += 100; // one token's worth
  const again = clientOp(add("a3"));
  await room.submit(a, { ...again, opId: rejects(a)[0]?.opId ?? "" });
  expect(room.doc.nodes["a3"]).toBeDefined();
});

test("rate limit: after a refusal, LATER ops are refused too until the refused one is sent again (order is kept)", async () => {
  const { room, clock } = timedRoom({ perSecond: 10, burst: 1 });
  const a = peer("a");
  room.join(a);
  await room.submit(a, clientOp(add("first")));
  const parent = clientOp(add("parent"));
  await room.submit(a, parent); // refused: no tokens
  clock.now += 1000; // plenty of budget again, but the peer has not yet retried "parent"
  const child = clientOp(add("child", "parent"));
  await room.submit(a, child);
  expect(rejects(a).map((r) => r.reason)).toEqual(["rate_limited", "rate_limited"]); // NOT "gone": it would have been lost for good
  await room.submit(a, parent);
  clock.now += 100; // a burst of 1: the next token
  await room.submit(a, child);
  expect(room.doc.nodes["child"]?.parentId).toBe("parent");
});

test("rate limit: the budget belongs to the ACTOR, so reconnecting does not refill it", async () => {
  const { room } = timedRoom({ perSecond: 10, burst: 2 });
  const first = peer("a");
  room.join(first);
  await room.submit(first, clientOp(add("n1")));
  await room.submit(first, clientOp(add("n2")));
  room.leave(first);
  const second = peer("a"); // the same user, a new connection
  room.join(second);
  await room.submit(second, clientOp(add("n3")));
  expect(rejects(second).map((r) => r.reason)).toEqual(["rate_limited"]);
});

test("rate limit: a peer that keeps sending while refused is dropped", async () => {
  const { room } = timedRoom({ perSecond: 1, burst: 1, maxStrikes: 5 });
  let kicked = 0;
  const a = { ...peer("a"), kick: () => { kicked++; } };
  room.join(a);
  for (let i = 0; i < 10; i++) await room.submit(a, clientOp(add(`n${String(i)}`)));
  expect(kicked).toBe(1);
  expect(room.peerCount).toBe(0);
  expect(rejects(a).length).toBeLessThanOrEqual(6); // and it is no longer answered
});

/** Two peers; `a` has made node "n" with gap 4 (seq 2); then `b` sets gap to 4 again: an op that changes nothing. */
async function afterANoOp() {
  const room = createRoom({ doc: emptyDoc(), manifest });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  await room.submit(a, clientOp(add("n")));
  await room.submit(a, clientOp(setGap("n", 4)));
  const same = clientOp(setGap("n", 4), 2);
  await room.submit(b, same);
  return { room, a, b, same };
}

test("an op that changes nothing is acknowledged to its sender only, and takes no sequence number", async () => {
  const { room, a, b, same } = await afterANoOp();
  expect(b.inbox.at(-1)).toEqual({ type: "ack", opId: same.opId });
  expect(room.seq).toBe(2);
  expect(ops(a)).toHaveLength(2); // a heard nothing about it
});

test("a no-op is REMEMBERED: its resend stays a no-op even if the document has moved on since", async () => {
  const { room, a, b, same } = await afterANoOp();
  await room.submit(a, clientOp(setGap("n", 9), 2));
  await room.submit(b, same); // the resend of an ack b never heard: must not put 4 back over 9
  expect(room.doc.nodes["n"]?.props["gap"]).toBe(9);
  expect(b.inbox.at(-1)).toEqual({ type: "ack", opId: same.opId });
});
