import { expect, test, vi } from "vitest";
import type { Actor, ClientOp, Manifest, Op, SequencedOp, ServerMessage } from "@noon/contracts";
import { emptyDoc, ROOT_ID } from "@noon/doc-model";
import { createRoom, type Journal, type Peer } from "./room.ts";

// The room is pure logic, so its rules are tested here without sockets. Each test below reproduces a
// finding from the E2.3 review.

const manifest: Manifest = { version: 1, components: [{ name: "Stack", acceptsChildren: true, props: [{ name: "gap", type: { kind: "number" }, required: false }] }] };
let nextId = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
const add = (nodeId: string, parentId = ROOT_ID): Op => ({ type: "add_node", nodeId, parentId, index: 99, component: "Stack", props: {} });
const setGap = (nodeId: string, value: number): Op => ({ type: "set_prop", nodeId, key: "gap", value });
const clientOp = (op: Op, baseSeq = 0, opId = uuid()): ClientOp => ({ opId, baseSeq, op });

function peer(id: string, kind: Actor["kind"] = "user"): Peer & { inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  return { actor: { kind, id }, session: { userId: id, orgId: "org", expiresAt: 0 }, mayEdit: true, inbox, send: (m) => void inbox.push(m) };
}
const ops = (p: { inbox: ServerMessage[] }) => p.inbox.filter((m): m is Extract<ServerMessage, { type: "op" }> => m.type === "op");
const rejects = (p: { inbox: ServerMessage[] }) => p.inbox.filter((m): m is Extract<ServerMessage, { type: "rejected" }> => m.type === "rejected");
/** A journal that only takes ops through `persist` (to delay or fail them) and remembers nothing. */
const persisting = (persist: (op: SequencedOp) => Promise<void>): Journal => ({
  append: async (op) => { await persist(op); return undefined; },
  find: () => Promise.resolve(undefined),
  everAdded: () => Promise.resolve(false),
  since: () => Promise.resolve([]),
});
/** A journal in memory with the table's two unique keys, outliving any room built on it: a stand-in for op_journal. */
function memoryJournal(): Journal & { rows: SequencedOp[] } {
  const rows: SequencedOp[] = [];
  const find = (actorId: string, opId: string) => rows.find((r) => r.actor.id === actorId && r.opId === opId);
  return {
    rows,
    append(op) {
      const original = find(op.actor.id, op.opId);
      if (original) return Promise.resolve(original);
      if (rows.some((r) => r.seq === op.seq)) return Promise.reject(new Error("op_journal_seq"));
      rows.push(op);
      return Promise.resolve(undefined);
    },
    find: (actorId, opId) => Promise.resolve(find(actorId, opId)),
    everAdded: (nodeId) => Promise.resolve(rows.some((r) => r.op.type === "add_node" && r.op.nodeId === nodeId)),
    since: (seq) => Promise.resolve(rows.filter((r) => r.seq > seq).sort((x, y) => x.seq - y.seq)),
  };
}

test("the welcome carries a COPY of the document: later ops must not change a message already handed out", async () => {
  const room = createRoom({ doc: emptyDoc(), manifest, mintPeerId: () => "p1" });
  const a = peer("a");
  room.join(a);
  const welcomed = a.inbox[0];
  await room.submit(a, clientOp(add("n1")));
  expect(welcomed).toEqual({ type: "welcome", doc: emptyDoc(), seq: 0, you: "p1", peers: [] });
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
  const room = createRoom({ doc: emptyDoc(), manifest, journal: persisting(async (op) => { await gate; persisted.push(op.seq); }) });
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
  const room = createRoom({ doc: emptyDoc(), manifest, journal: persisting(() => (fail ? Promise.reject(new Error("journal down")) : Promise.resolve())) });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  const op = clientOp(add("n1"));
  await room.submit(a, op);
  expect(rejects(a)).toEqual([{ type: "rejected", opId: op.opId, reason: "unavailable" }]);
  expect(ops(b)).toEqual([]);
  expect(room.doc.nodes["n1"]).toBeUndefined();
  fail = false;
  expect(await room.recover()).toBe(true); // E6.1b: the room refuses everything until storage answers again
  await room.submit(a, op); // the client retries the same op
  expect(ops(b).map((m) => m.seq)).toEqual([1]); // no gap in the numbering
});

// --- E6.1a: the journal is written before anyone hears of an op, and it outlives the room ----------
test("journal: every accepted op is journaled BEFORE it is broadcast, in the order it is broadcast, under concurrent submits", async () => {
  const journal = memoryJournal();
  const order: string[] = [];
  const room = createRoom({ doc: emptyDoc(), manifest, journal: { ...journal, append: async (op) => { await Promise.resolve(); order.push(`journal ${String(op.seq)}`); return journal.append(op); } } });
  const watcher: Peer = { actor: { kind: "user", id: "w" }, session: { userId: "w", orgId: "org", expiresAt: 0 }, mayEdit: true, send: (m) => { if (m.type === "op") order.push(`broadcast ${String(m.seq)}`); } };
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b); room.join(watcher);
  await Promise.all(Array.from({ length: 20 }, (_, i) => room.submit(i % 2 ? a : b, clientOp(add(`n${String(i)}`)))));
  expect(order).toEqual(Array.from({ length: 20 }, (_, i) => [`journal ${String(i + 1)}`, `broadcast ${String(i + 1)}`]).flat());
  expect(journal.rows.map((r) => r.seq)).toEqual(ops(a).map((m) => m.seq));
});

test("journal: a resend after the room restarted gets its ORIGINAL seq, and nothing is applied twice", async () => {
  const journal = memoryJournal();
  const first = createRoom({ doc: emptyDoc(), manifest, journal });
  const a = peer("a");
  first.join(a);
  const move = clientOp({ type: "move_node", nodeId: "n2", newParentId: "n1", index: 0 }, 2);
  for (const op of [clientOp(add("n1")), clientOp(add("n2"), 1), move, clientOp(add("n3"), 3)]) await first.submit(a, op);
  // The ack of the move was lost. The room is rebuilt from what was saved (here: its final state).
  const again = createRoom({ doc: structuredClone(first.doc), seq: first.seq, manifest, journal });
  const back = peer("a");
  again.join(back);
  await again.submit(back, move);
  expect(ops(back)).toEqual([{ type: "op", seq: 3, opId: move.opId, actor: { kind: "user", id: "a" }, op: move.op }]);
  expect(again.seq).toBe(4);
  expect(journal.rows).toHaveLength(4);
});

test("journal: a client that resends its own forgotten op with a FORGED high baseSeq gets the original seq, not a second one (E2.3 known limit)", async () => {
  const journal = memoryJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal, limits: { rememberedOps: 2 } });
  const liar = peer("liar");
  room.join(liar);
  await room.submit(liar, clientOp(add("n1")));
  const setOnce = clientOp(setGap("n1", 8), 1);
  await room.submit(liar, setOnce); // seq 2
  for (let i = 0; i < 3; i++) await room.submit(liar, clientOp(setGap("n1", 10 + i), 2 + i)); // pushes seq 2 out of the room's memory
  await room.submit(liar, { ...setOnce, baseSeq: room.seq }); // "I have seen everything": the stale guard is passed
  expect(ops(liar).at(-1)).toMatchObject({ seq: 2, opId: setOnce.opId });
  expect(room.doc.nodes["n1"]?.props["gap"]).toBe(12); // the old value was NOT written again
  expect(journal.rows.filter((r) => r.opId === setOnce.opId)).toHaveLength(1);
});

test("journal: after a restart, a FORGED-baseSeq resend of an add, a remove or a now-unchanged set gets its original seq, not duplicate_node, gone or a bare ack (noon-mo3.1.1)", async () => {
  const journal = memoryJournal();
  const first = createRoom({ doc: emptyDoc(), manifest, journal });
  const a = peer("a");
  first.join(a);
  const sent = [clientOp(add("outer")), clientOp(add("inner", "outer"), 1), clientOp(setGap("outer", 24), 2), clientOp(add("doomed"), 3), clientOp({ type: "remove_node", nodeId: "doomed" }, 4)];
  for (const op of sent) await first.submit(a, op);
  // journal.int.test.ts's sequence: the room is rebuilt at seq 5 and remembers nothing; each op is resent claiming to have seen everything.
  const again = createRoom({ doc: structuredClone(first.doc), seq: first.seq, manifest, journal });
  const back = peer("a");
  again.join(back);
  const resent = [0, 2, 4, 3].map((i) => ({ opId: sent[i]?.opId, seq: i + 1 }));
  for (const i of [0, 2, 4, 3]) await again.submit(back, { ...(sent[i] as ClientOp), baseSeq: again.seq });
  expect(rejects(back)).toEqual([]);
  expect(back.inbox.filter((m) => m.type === "ack")).toEqual([]);
  expect(ops(back).map(({ opId, seq }) => ({ opId, seq }))).toEqual(resent);
  expect(again.seq).toBe(5);
  expect(again.doc).toEqual(first.doc);
  expect(journal.rows).toHaveLength(5);
});

test("journal: a FORGED-baseSeq op that was never journaled is still refused for what it is", async () => {
  const journal = memoryJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const a = peer("a");
  room.join(a);
  await room.submit(a, clientOp(add("n1")));
  const twin = clientOp(add("n1"), 1);
  await room.submit(a, twin);
  expect(rejects(a)).toEqual([{ type: "rejected", opId: twin.opId, reason: "duplicate_node" }]);
});

test("journal: an op sent against an old seq that never arrived is judged now, not refused as stale", async () => {
  const journal = memoryJournal();
  const room = createRoom({ doc: emptyDoc(), seq: 0, manifest, journal });
  const a = peer("a");
  room.join(a);
  await room.submit(a, clientOp(add("n1")));
  const reloaded = createRoom({ doc: structuredClone(room.doc), seq: room.seq, manifest, journal });
  const b = peer("b");
  reloaded.join(b);
  await reloaded.submit(b, clientOp(add("n2"), 0)); // b wrote this before it saw seq 1
  expect(ops(b).map((m) => m.seq)).toEqual([2]);
  expect(rejects(b)).toEqual([]);
});

test("journal: a node id that was added and removed is never added again, even after a restart (keystone 4)", async () => {
  const journal = memoryJournal();
  const first = createRoom({ doc: emptyDoc(), manifest, journal });
  const a = peer("a");
  first.join(a);
  await first.submit(a, clientOp(add("gone")));
  await first.submit(a, clientOp({ type: "remove_node", nodeId: "gone" }, 1));
  const again = createRoom({ doc: structuredClone(first.doc), seq: first.seq, manifest, journal });
  const git = peer("git-peer", "git");
  again.join(git);
  const readd = clientOp(add("gone"), 2);
  await again.submit(git, readd);
  expect(rejects(git)).toEqual([{ type: "rejected", opId: readd.opId, reason: "duplicate_node" }]);
  expect(again.doc.nodes["gone"]).toBeUndefined();
});

test("journal: if the journal cannot be read, the op is refused as unavailable and nobody receives it", async () => {
  const down = (): Promise<never> => Promise.reject(new Error("db down"));
  const room = createRoom({ doc: emptyDoc(), seq: 5, manifest, journal: { append: down, find: down, everAdded: down, since: down } });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  const old = clientOp(add("n1"), 0); // behind what the room remembers: the journal is asked
  const fresh = clientOp(add("n2"), 5); // an add: the journal is asked whether the id was used
  await room.submit(a, old);
  await room.submit(a, fresh);
  expect(rejects(a).map((r) => r.reason)).toEqual(["unavailable", "unavailable"]);
  expect(ops(b)).toEqual([]);
  expect(room.seq).toBe(5);
});

// --- E6.1b: with its storage unavailable the room is read-only, says so to every peer, and recovers ---
/** memoryJournal behind a switch: while `down`, every call rejects; `committedAnyway` makes the next append land AND reject (a lost reply). */
function flakyJournal() {
  const inner = memoryJournal();
  const state = { down: false, committedAnyway: false, appends: 0 };
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => (...args: A): Promise<R> => (state.down ? Promise.reject(new Error("db down")) : call(...args));
  const journal: Journal = {
    append: async (op) => {
      state.appends++;
      if (state.committedAnyway) {
        state.committedAnyway = false;
        await inner.append(op);
        throw new Error("connection lost after commit");
      }
      return guard((each: SequencedOp) => inner.append(each))(op);
    },
    find: guard((actorId: string, opId: string) => inner.find(actorId, opId)),
    everAdded: guard((nodeId: string) => inner.everAdded(nodeId)),
    since: guard((seq: number) => inner.since(seq)),
  };
  return { journal, state, rows: inner.rows };
}
const statuses = (p: { inbox: ServerMessage[] }) => p.inbox.filter((m) => m.type === "status");

test("read-only: a failed append tells EVERY peer the room is read-only, before the sender hears its refusal", async () => {
  const { journal, state } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const [a, b, ai] = [peer("a"), peer("b"), peer("run", "agent")];
  room.join(a); room.join(b); room.join(ai);
  state.down = true;
  const op = clientOp(add("n1"));
  await room.submit(a, op);
  expect(room.readOnly).toBe(true);
  expect(a.inbox.slice(1)).toEqual([{ type: "status", readOnly: true }, { type: "rejected", opId: op.opId, reason: "unavailable" }]);
  for (const other of [b, ai]) expect(other.inbox.slice(1)).toEqual([{ type: "status", readOnly: true }]);
});

test("read-only: every op is refused and NONE is acknowledged: not a fresh one, not a no-op, not a resend the room remembers; the journal is not even asked", async () => {
  const { journal, state } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const a = peer("a");
  room.join(a);
  const first = clientOp(add("n1"));
  await room.submit(a, first); // seq 1, remembered
  await room.submit(a, clientOp(setGap("n1", 8), 1)); // seq 2
  state.down = true;
  await room.submit(a, clientOp(setGap("n1", 9), 2)); // fails: read-only from here
  const appendsBefore = state.appends;
  const inbox = a.inbox.length;
  await room.submit(a, clientOp(setGap("n1", 10), 2)); // fresh
  await room.submit(a, clientOp(setGap("n1", 8), 2)); // a no-op (gap is already 8)
  await room.submit(a, first); // a resend the room still remembers
  state.down = false; // storage is back, but nobody has told the room: it must stay read-only until recover()
  await room.submit(a, clientOp(setGap("n1", 11), 2));
  expect(a.inbox.slice(inbox).map((m) => m.type === "rejected" ? m.reason : m.type)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
  expect(state.appends).toBe(appendsBefore);
  expect(room.seq).toBe(2);
  expect(room.doc.nodes["n1"]?.props["gap"]).toBe(8);
});

test("read-only: ops already queued behind the failing append are refused, not written", async () => {
  const { journal, state } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  await room.submit(a, clientOp(add("n1")));
  state.down = true;
  const appendsBefore = state.appends;
  await Promise.all([room.submit(a, clientOp(setGap("n1", 1), 1)), room.submit(b, clientOp(setGap("n1", 2), 1)), room.submit(a, clientOp(setGap("n1", 3), 1))]);
  expect(state.appends - appendsBefore).toBe(1);
  expect(rejects(a).map((r) => r.reason)).toEqual(["unavailable", "unavailable"]);
  expect(rejects(b).map((r) => r.reason)).toEqual(["unavailable"]);
  expect(statuses(b)).toEqual([{ type: "status", readOnly: true }]); // said once, not once per refusal
});

test("read-only: a peer that joins while the room is read-only is told so in its welcome", async () => {
  const { journal, state } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal, mintPeerId: () => "p" });
  const a = peer("a");
  room.join(a);
  expect(a.inbox[0]).not.toHaveProperty("readOnly"); // a writable room's welcome is unchanged
  state.down = true;
  await room.submit(a, clientOp(add("n1")));
  const late = peer("late", "git");
  room.join(late);
  expect(late.inbox[0]).toMatchObject({ type: "welcome", readOnly: true });
});

test("recover: while storage is still down it changes nothing and says nothing; once it answers, every peer hears 'writable' and numbering goes on with no gap", async () => {
  const { journal, state, rows } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  expect(await room.recover()).toBe(true); // a writable room: nothing to do, nothing said
  expect(statuses(b)).toEqual([]);
  const n1 = clientOp(add("n1"));
  await room.submit(a, n1); // seq 1
  state.down = true;
  const refused = clientOp(add("n2"), 1);
  await room.submit(a, refused);
  expect(await room.recover()).toBe(false);
  expect(room.readOnly).toBe(true);
  expect(statuses(b)).toEqual([{ type: "status", readOnly: true }]);
  state.down = false;
  expect(await room.recover()).toBe(true);
  expect(room.readOnly).toBe(false);
  expect(statuses(b)).toEqual([{ type: "status", readOnly: true }, { type: "status", readOnly: false }]);
  await room.submit(a, refused); // the held op goes out again, as peer-client does on "writable"
  expect(ops(b).map((m) => [m.seq, m.opId])).toEqual([[1, n1.opId], [2, refused.opId]]);
  expect(rows.map((r) => r.seq)).toEqual([1, 2]);
});

test("recover: an append that LANDED although its reply was lost is replayed to everyone with its seq, so the resend is answered, not applied twice", async () => {
  const { journal, state, rows } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  state.committedAnyway = true;
  const op = clientOp(add("n1"));
  await room.submit(a, op);
  expect(rejects(a).map((r) => r.reason)).toEqual(["unavailable"]);
  expect(ops(b)).toEqual([]); // nobody heard of it: it was not KNOWN to be durable
  expect(await room.recover()).toBe(true);
  // The journal is the truth: the op is in it, so the room applies it and everyone hears it, BEFORE "writable".
  expect(b.inbox.slice(-2)).toMatchObject([{ type: "op", seq: 1, opId: op.opId, actor: { id: "a" } }, { type: "status", readOnly: false }]);
  expect(room.doc.nodes["n1"]).toBeDefined();
  await room.submit(a, op); // the sender's held copy comes back
  expect(ops(a).filter((m) => m.opId === op.opId).map((m) => m.seq)).toEqual([1, 1]);
  expect(rows).toHaveLength(1);
  const next = clientOp(add("n2"), 1);
  await room.submit(a, next);
  expect(ops(b).at(-1)).toMatchObject({ seq: 2, opId: next.opId });
});

test("recover: a rival's row at the room's next seq does not keep the room refusing until a restart: it is replayed, and the room goes on after it", async () => {
  const { journal, rows } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const a = peer("a");
  room.join(a);
  rows.push({ seq: 1, opId: uuid(), actor: { kind: "user", id: "rival" }, op: add("rival") }); // written behind the room's back
  const mine = clientOp(add("mine"));
  await room.submit(a, mine);
  expect(room.readOnly).toBe(true);
  expect(await room.recover()).toBe(true);
  expect(room.doc.nodes["rival"]).toBeDefined();
  await room.submit(a, mine);
  expect(ops(a).map((m) => [m.seq, m.actor.id])).toEqual([[1, "rival"], [2, "a"]]);
  expect(room.seq).toBe(2);
});

test("recover: takes its turn in the op queue: an op submitted before it is refused, one submitted after it is accepted", async () => {
  const { journal, state } = flakyJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const a = peer("a");
  room.join(a);
  state.down = true;
  await room.submit(a, clientOp(add("n1")));
  state.down = false;
  const [before, after] = [clientOp(add("n2")), clientOp(add("n3"))];
  await Promise.all([room.submit(a, before), room.recover(), room.submit(a, after)]);
  expect(a.inbox.slice(1).map((m) => m.type === "rejected" ? `rejected ${m.opId === before.opId ? "before" : "n1"}` : m.type === "op" ? `op ${m.opId === after.opId ? "after" : "?"}` : m.type)).toEqual(["status", "rejected n1", "rejected before", "status", "op after"]);
});

test("onReadOnly is called once per fall, so the caller can start retrying recover()", async () => {
  const { journal, state } = flakyJournal();
  const onReadOnly = vi.fn();
  const room = createRoom({ doc: emptyDoc(), manifest, journal, onReadOnly });
  const a = peer("a");
  room.join(a);
  state.down = true;
  await room.submit(a, clientOp(add("n1")));
  await room.submit(a, clientOp(add("n2")));
  expect(onReadOnly).toHaveBeenCalledTimes(1);
  state.down = false;
  await room.recover();
  state.down = true;
  await room.submit(a, clientOp(add("n3")));
  expect(onReadOnly).toHaveBeenCalledTimes(2);
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
  expect(rejects(a)).toEqual([{ type: "rejected", opId: expect.any(String) as string, reason: "rate_limited", retryAfterMs: 300 }]); // until the whole burst of 3 is back: worth returning for
  expect(room.seq).toBe(3); // a refused op takes no sequence number
});

test("rate limit: the budget refills with time, and one peer's flood does not spend another peer's budget", async () => {
  const { room, clock } = timedRoom({ perSecond: 10, burst: 2 });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  for (const id of ["a1", "a2", "a3"]) await room.submit(a, clientOp(add(id)));
  await room.submit(b, clientOp(add("b1")));
  expect(room.doc.nodes["b1"]).toBeDefined();
  expect(rejects(a)).toHaveLength(1);
  clock.now += 100; // one token's worth
  await room.submit(a, { ...clientOp(add("a3")), opId: rejects(a)[0]?.opId ?? "" });
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
  expect(rejects(a)).toHaveLength(5); // refused maxStrikes times, dropped on the next, and no longer answered
});

test("rate limit: a peer that WAITS as told is never dropped, however often it loses the race for the token", async () => {
  // Two tabs of one user share one budget. Tab A is greedy and always gets there first.
  const { room, clock } = timedRoom({ perSecond: 10, burst: 1, maxStrikes: 3 });
  let kicked = 0;
  const greedy = peer("u");
  const patient = { ...peer("u"), kick: () => { kicked++; } };
  room.join(greedy); room.join(patient);
  const wanted = clientOp(add("patient"));
  for (let tick = 0; tick < 20; tick++) {
    await room.submit(greedy, clientOp(add(`g${String(tick)}`)));
    await room.submit(patient, wanted); // refused again: but it came back no sooner than it was told to
    clock.now += 100;
  }
  expect(kicked).toBe(0);
  expect(rejects(patient).length).toBeGreaterThan(10);
});

test("rate limit: an agent run has its own budget and cannot spend its owner's", async () => {
  const { room } = timedRoom({ perSecond: 10, burst: 2 });
  const human = peer("u");
  const agent: ReturnType<typeof peer> = { ...peer("u", "agent"), actor: { kind: "agent", id: "u", runId: "run-1" } };
  room.join(human); room.join(agent);
  for (const id of ["a1", "a2", "a3", "a4"]) await room.submit(agent, clientOp(add(id)));
  await room.submit(human, clientOp(add("h1")));
  expect(room.doc.nodes["h1"]).toBeDefined();
});

test("rate limit: the budget is charged ON ARRIVAL, not when a slow journal finally reaches the op", async () => {
  let release = (): void => undefined;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const room = createRoom({ doc: emptyDoc(), manifest, rate: { perSecond: 10, burst: 3 }, now: () => 0, journal: persisting(() => slow) });
  const a = peer("a");
  room.join(a);
  for (let i = 0; i < 50; i++) void room.submit(a, clientOp(add(`n${String(i)}`)));
  expect(rejects(a)).toHaveLength(47); // refused at once: 47 ops are NOT sitting in memory behind the journal
  release();
  await room.settled();
  expect(room.seq).toBe(3);
});

test("rate limit: odd budgets and an odd clock still give a finite, whole retryAfterMs and no debt", async () => {
  const frozen = timedRoom({ perSecond: 0, burst: 1 });
  const a = peer("a");
  frozen.room.join(a);
  await frozen.room.submit(a, clientOp(add("n1")));
  await frozen.room.submit(a, clientOp(add("n2")));
  expect(Number.isSafeInteger(rejects(a)[0]?.retryAfterMs)).toBe(true);

  const { room, clock } = timedRoom({ perSecond: 10, burst: 1 });
  const b = peer("b");
  room.join(b);
  clock.now = 1_000_000;
  await room.submit(b, clientOp(add("n1")));
  clock.now = 0; // the clock was corrected backwards
  const n2 = clientOp(add("n2"));
  await room.submit(b, n2); // refused: no token yet. The room now measures from the corrected clock...
  expect(rejects(b)[0]?.retryAfterMs).toBe(100);
  clock.now += 100;
  await room.submit(b, n2);
  expect(room.doc.nodes["n2"]).toBeDefined(); // ...so one token later it works: no debt of a million ms
});

test("noon-3m1: the room's memory budget counts UTF-8 bytes, not characters", async () => {
  const withText: Manifest = { version: 1, components: [{ name: "Text", acceptsChildren: false, props: [{ name: "label", type: { kind: "string" }, required: false }] }] };
  const room = createRoom({ doc: emptyDoc(), manifest: withText, limits: { rememberedBytes: 2500 } });
  const a = peer("a");
  room.join(a);
  // About 1,080 UTF-16 units but 3,080 bytes: it does not fit in 2,500 bytes, so the room cannot keep it.
  const big = clientOp({ type: "add_node", nodeId: "t", parentId: ROOT_ID, index: 0, component: "Text", props: { label: "\u4e2d".repeat(1000) } });
  await room.submit(a, big);
  await room.submit(a, big);
  expect(a.inbox.at(-1)).toEqual({ type: "rejected", opId: big.opId, reason: "stale" }); // forgotten, and said so: never applied twice
});

test("a flood of no-ops cannot push real ops out of the room's memory: an honest resend is still recognised", async () => {
  const room = createRoom({ doc: emptyDoc(), manifest, limits: { rememberedOps: 5 }, rate: { perSecond: 1e6, burst: 1e6 } });
  const [honest, flooder] = [peer("honest"), peer("flooder")];
  room.join(honest); room.join(flooder);
  const mine = clientOp(add("mine"));
  await room.submit(honest, mine);
  for (let i = 0; i < 50; i++) await room.submit(flooder, clientOp({ type: "set_prop", nodeId: "mine", key: "gap", value: null }, 1));
  await room.submit(honest, mine); // the acknowledgement was lost: the ordinary resend
  expect(honest.inbox.at(-1)).toMatchObject({ type: "op", seq: 1 }); // the original answer, not "stale"
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

// --- E2.6 presence: relayed, remembered in memory for newcomers, never sequenced or persisted -----
const presenceOf = (p: { inbox: ServerMessage[] }) => p.inbox.filter((m): m is Extract<ServerMessage, { type: "presence" }> => m.type === "presence");

test("presence goes to the OTHERS, stamped with who sent it; it takes no seq and never reaches persist", async () => {
  const persisted: SequencedOp[] = [];
  const room = createRoom({ doc: emptyDoc(), manifest, journal: persisting((op) => { persisted.push(op); return Promise.resolve(); }) });
  const [a, b] = [{ ...peer("a"), name: "Ada" }, peer("b")];
  room.join(a); room.join(b);
  room.presence(a, { cursor: { x: 0.1, y: 0.2 }, selection: "n1" });
  await room.settled();
  expect(presenceOf(b)).toEqual([{ type: "presence", peerId: expect.any(String) as string, actor: { kind: "user", id: "a" }, name: "Ada", cursor: { x: 0.1, y: 0.2 }, selection: "n1" }]);
  expect(presenceOf(a)).toEqual([]); // not echoed to the sender
  expect(room.seq).toBe(0);
  expect(persisted).toEqual([]);
  expect(JSON.stringify(room.doc)).not.toContain("0.1");
});

test("a newcomer is told who is already here (and its own peerId); someone who leaves is announced", () => {
  const room = createRoom({ doc: emptyDoc(), manifest });
  const [a, b] = [{ ...peer("a"), name: "Ada" }, peer("b")];
  room.join(a);
  room.presence(a, { cursor: null, selection: "n1" });
  room.join(b);
  const welcome = b.inbox[0];
  expect(welcome?.type === "welcome" && welcome.peers?.map((p) => [p.name, p.selection])).toEqual([["Ada", "n1"]]);
  expect(welcome?.type === "welcome" && typeof welcome.you).toBe("string");
  room.leave(a);
  const peerId = welcome?.type === "welcome" ? welcome.peers?.[0]?.peerId : undefined;
  expect(b.inbox.at(-1)).toEqual({ type: "presence_left", peerId });
  room.join(peer("c"));
});

test("two tabs of one user are two presences: presence belongs to the CONNECTION", () => {
  const room = createRoom({ doc: emptyDoc(), manifest });
  const [tab1, tab2, watcher] = [peer("u"), peer("u"), peer("w")];
  room.join(tab1); room.join(tab2); room.join(watcher);
  room.presence(tab1, { cursor: null, selection: "n1" });
  room.presence(tab2, { cursor: null, selection: "n2" });
  expect(new Set(presenceOf(watcher).map((p) => p.peerId)).size).toBe(2);
});

test("presence that arrives faster than the room relays it is dropped, and the room needs no timer for that", () => {
  const clock = { now: 0 };
  const room = createRoom({ doc: emptyDoc(), manifest, now: () => clock.now });
  const [a, b] = [peer("a"), peer("b")];
  room.join(a); room.join(b);
  for (let i = 0; i < 100; i++) room.presence(a, { cursor: { x: i / 100, y: 0 }, selection: null });
  expect(presenceOf(b)).toHaveLength(1);
  clock.now += 30;
  room.presence(a, { cursor: { x: 1, y: 1 }, selection: null });
  expect(presenceOf(b)).toHaveLength(2);
});

test("a presence message is turned into JSON ONCE however many peers receive it", () => {
  const room = createRoom({ doc: emptyDoc(), manifest });
  const texts: string[] = [];
  for (const n of [1, 2, 3]) room.join({ ...peer(`p${String(n)}`), sendText: (text: string) => void texts.push(text) });
  const sender = peer("sender");
  room.join(sender);
  const stringify = vi.spyOn(JSON, "stringify");
  room.presence(sender, { cursor: null, selection: "n1" });
  expect(stringify).toHaveBeenCalledTimes(1);
  stringify.mockRestore();
  expect(texts.filter((t) => t.includes('"presence"'))).toHaveLength(3);
});

test("onAccepted hears every seq the room applies, and nothing it refuses", async () => {
  const journal = memoryJournal();
  const heard: number[] = [];
  const room = createRoom({ doc: emptyDoc(), manifest, journal, onAccepted: (seq) => void heard.push(seq) });
  const a = peer("a");
  room.join(a);
  await room.submit(a, clientOp(add("n1")));
  await room.submit(a, clientOp(add("n1"), 1)); // duplicate node: refused
  await room.submit(a, clientOp(setGap("n1", 4), 1));
  expect(heard).toEqual([1, 2]);
  expect(rejects(a)).toHaveLength(1);
});

// E8.2 (F24): a viewer sees everything and changes nothing.
test("a viewer's op is refused as forbidden, applied to nothing and heard by nobody, while it still sees the others' ops and presence", async () => {
  const journal = memoryJournal();
  const room = createRoom({ doc: emptyDoc(), manifest, journal });
  const [editor, viewer] = [peer("e"), { ...peer("v"), mayEdit: false }];
  room.join(editor); room.join(viewer);
  const refused = clientOp(add("from-viewer"));
  await room.submit(viewer, refused);
  expect(rejects(viewer)).toEqual([{ type: "rejected", opId: refused.opId, reason: "forbidden" }]);
  expect(room.doc.nodes["from-viewer"]).toBeUndefined();
  expect(journal.rows).toEqual([]);
  expect(room.seq).toBe(0);
  expect(editor.inbox.filter((m) => m.type !== "welcome")).toEqual([]); // nobody heard of it

  await room.submit(editor, clientOp(add("from-editor")));
  expect(ops(viewer).map((m) => m.seq)).toEqual([1]); // it sees the edit live
  room.presence(editor, { cursor: { x: 0.5, y: 0.5 }, selection: null });
  expect(viewer.inbox.some((m) => m.type === "presence")).toBe(true);
});

test("the role is asked when an op's turn comes: an op queued before a demotion is refused, and a promotion takes effect on the next op", async () => {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const persisting1 = new Promise<void>((resolve) => { started = resolve; });
  const slow = persisting((op) => (op.seq === 1 ? new Promise<void>((resolve) => { release = resolve; started(); }) : Promise.resolve()));
  const room = createRoom({ doc: emptyDoc(), manifest, journal: slow });
  const p = peer("p");
  room.join(p);
  const first = room.submit(p, clientOp(add("one")));
  const queued = clientOp(add("two"));
  const second = room.submit(p, queued); // waits behind `first`
  await persisting1; // `one` was judged and is being made durable
  p.mayEdit = false; // an owner made p a viewer while `two` was waiting
  release();
  await Promise.all([first, second]);
  expect(ops(p).map((m) => m.seq)).toEqual([1]);
  expect(rejects(p)).toEqual([{ type: "rejected", opId: queued.opId, reason: "forbidden" }]);

  p.mayEdit = true;
  await room.submit(p, clientOp(add("three"), 1));
  expect(ops(p).map((m) => m.seq)).toEqual([1, 2]);
});
