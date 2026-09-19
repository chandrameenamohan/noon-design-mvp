import { expect, test } from "vitest";
import type { Actor, ClientOp, Doc, Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOpInto, checkDoc, emptyDoc } from "@noon/doc-model";
import { randomOp, seeded } from "@noon/doc-model/random-ops";
import { createReplica, type DocMessage } from "./replica.ts";

const ME: Actor = { kind: "user", id: "me" };
const OTHER: Actor = { kind: "user", id: "other" };
const add = (nodeId: string, parentId = "root", index = 0): Extract<Op, { type: "add_node" }> => ({ type: "add_node", nodeId, parentId, index, component: "Stack", props: {} });
const text = (nodeId: string, value: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 0, component: "Text", props: { value } });
const setText = (nodeId: string, value: string): Op => ({ type: "set_prop", nodeId, key: "value", value });
const ack = (seq: number, sent: ClientOp, actor = ME): DocMessage => ({ type: "op", seq, opId: sent.opId, actor, op: sent.op });
const remote = (seq: number, op: Op): DocMessage => ({ type: "op", seq, opId: crypto.randomUUID(), actor: OTHER, op });

function ready(doc: Doc = emptyDoc(), seq = 0) {
  const replica = createReplica({ manifest });
  replica.receive({ type: "welcome", doc, seq });
  return replica;
}
/** Makes an edit that stays in the queue (the transport is offline); fails the test if the replica refused. */
function queued(replica: ReturnType<typeof createReplica>, op: Op): ClientOp {
  const result = replica.local(op);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  const made = replica.pending.at(-1);
  if (made?.opId !== result.opId) throw new Error("the op was not queued (it changed nothing)");
  return made;
}
/** Makes an edit and puts it on the wire, as a live transport does. */
function sent(replica: ReturnType<typeof createReplica>, op: Op): ClientOp {
  const made = queued(replica, op);
  replica.takeSendable();
  return made;
}

test("a local op shows at once, before the server has said anything", () => {
  const replica = ready();
  const out = sent(replica, add("a"));
  expect(replica.doc.nodes["a"]).toBeDefined();
  expect(replica.confirmed.nodes["a"]).toBeUndefined();
  expect(replica.pending).toHaveLength(1);
  expect(out).toMatchObject({ baseSeq: 0, op: add("a") });
});

test("nothing can be submitted before the first welcome", () => {
  expect(createReplica({ manifest }).local(add("a"))).toEqual({ ok: false, reason: "not_ready" });
});

test("baseSeq is the last seq this replica has SEEN when the op was made", () => {
  const replica = ready(emptyDoc(), 7);
  replica.receive(remote(8, add("x")));
  expect(sent(replica, add("a")).baseSeq).toBe(8);
});

test("the acknowledgement moves the op from pending to confirmed", () => {
  const replica = ready();
  const out = sent(replica, add("a"));
  replica.receive(ack(1, out));
  expect(replica.pending).toHaveLength(0);
  expect(replica.confirmed.nodes["a"]).toBeDefined();
  expect(replica.seq).toBe(1);
  expect(replica.doc).toEqual(replica.confirmed);
});

test("a remote op that lands first is ordered BEFORE the pending op: server order wins", () => {
  const replica = ready();
  sent(replica, add("mine", "root", 0));
  replica.receive(remote(1, add("theirs", "root", 0)));
  // Server order: theirs at 0, then mine inserted at 0 -> [mine, theirs].
  expect(replica.doc.nodes["root"]?.children).toEqual(["mine", "theirs"]);
  expect(replica.confirmed.nodes["root"]?.children).toEqual(["theirs"]);
});

test("a rejected op is rolled back and reported with its reason", () => {
  const replica = ready();
  const out = sent(replica, add("a"));
  const effects = replica.receive({ type: "rejected", opId: out.opId, reason: "document_limit" });
  expect(replica.doc.nodes["a"]).toBeUndefined();
  expect(replica.pending).toHaveLength(0);
  expect(effects.rejected).toEqual([{ opId: out.opId, op: add("a"), reason: "document_limit", quiet: false }]);
});

test("'gone' is reported as quiet: the node was removed by someone else, nothing to tell the user", () => {
  const replica = ready();
  sent(replica, text("t", "hi"));
  const edit = sent(replica, setText("t", "bye"));
  expect(replica.receive({ type: "rejected", opId: edit.opId, reason: "gone" }).rejected[0]?.quiet).toBe(true);
});

test("a local op is checked against the OPTIMISTIC document, and a bad one never leaves", () => {
  const replica = ready();
  sent(replica, text("t", "hi")); // only pending, not confirmed
  expect(replica.local(setText("t", "bye")).ok).toBe(true);
  expect(replica.local(setText("nobody", "x"))).toEqual({ ok: false, reason: "gone" });
  expect(replica.local({ ...add("b"), component: "Nope" })).toEqual({ ok: false, reason: "unknown_component" });
  expect(replica.pending).toHaveLength(2);
});

test("an op the contract refuses (props over 32 KB) never leaves", () => {
  const replica = ready();
  const huge: Op = { type: "add_node", nodeId: "big", parentId: "root", index: 0, component: "Text", props: { value: "x".repeat(9000), a: "x".repeat(9000), b: "x".repeat(9000), c: "x".repeat(9000) } };
  expect(replica.local(huge)).toEqual({ ok: false, reason: "invalid_op" });
  expect(replica.doc.nodes["big"]).toBeUndefined();
});

test("after a reconnect every pending op is sent again, same opId, same baseSeq, same order", () => {
  const replica = ready();
  const first = sent(replica, add("a"));
  const second = sent(replica, add("b"));
  replica.receive({ type: "welcome", doc: emptyDoc(), seq: 4 }); // the room moved on meanwhile
  expect(replica.takeSendable()).toEqual([first, second]); // baseSeq still 0: what the ops were WRITTEN against
  expect(replica.doc.nodes["b"]).toBeDefined();
});

test("a late acknowledgement for an op already inside the welcome is NOT applied again", () => {
  // Mine (seq 1) set the text; someone else (seq 2) overwrote it; I reconnect and the welcome holds both.
  const replica = ready();
  sent(replica, text("t", "v0"));
  const mine = sent(replica, setText("t", "mine"));
  const server = emptyDoc();
  applyOpInto(server, text("t", "v0"));
  applyOpInto(server, setText("t", "theirs"));
  replica.receive({ type: "welcome", doc: server, seq: 3 });
  replica.receive(ack(2, mine));
  expect(replica.pending.map((p) => p.opId)).not.toContain(mine.opId);
  expect(replica.doc.nodes["t"]?.props["value"]).toBe("theirs");
  expect(replica.seq).toBe(3);
});

test("a gap in the sequence asks for a resync and applies nothing", () => {
  const replica = ready();
  const effects = replica.receive(remote(5, add("x")));
  expect(effects.resync).toBe(true);
  expect(replica.confirmed.nodes["x"]).toBeUndefined();
  expect(replica.seq).toBe(0);
});

test("'unavailable' keeps the op pending and asks for a resync: it was not applied and may be retried", () => {
  const replica = ready();
  const out = sent(replica, add("a"));
  const effects = replica.receive({ type: "rejected", opId: out.opId, reason: "unavailable" });
  expect(effects).toMatchObject({ resync: true, rejected: [] });
  expect(replica.pending).toHaveLength(1);
});

test("'stale': an op the document already shows is dropped quietly", () => {
  const replica = ready();
  const out = sent(replica, add("a"));
  const server = emptyDoc();
  applyOpInto(server, add("a"));
  replica.receive({ type: "welcome", doc: server, seq: 9 });
  const effects = replica.receive({ type: "rejected", opId: out.opId, reason: "stale" });
  expect(effects).toEqual({ rejected: [], resync: false });
  expect(replica.pending).toHaveLength(0);
});

test("'stale', first sent AFTER this welcome: no earlier room can have applied it, so it is sent again on top of what we now know", () => {
  const replica = ready();
  const out = queued(replica, add("a")); // the transport was offline: it never reached a socket
  replica.receive({ type: "welcome", doc: emptyDoc(), seq: 9 });
  expect(replica.takeSendable()).toEqual([out]);
  replica.receive({ type: "rejected", opId: out.opId, reason: "stale" });
  expect(replica.takeSendable()).toEqual([{ ...out, baseSeq: 9 }]);
  expect(replica.doc.nodes["a"]).toBeDefined();
});

test("'stale', already sent once: it MAY have been applied and overwritten since, so it is never sent again", () => {
  // Mine set gap=1 at seq 11 (unheard); someone set gap=2 at seq 12; the room was reloaded and forgot both.
  const replica = ready();
  sent(replica, add("t"));
  const mine = sent(replica, { type: "set_prop", nodeId: "t", key: "gap", value: 1 });
  const server = emptyDoc();
  applyOpInto(server, add("t"));
  applyOpInto(server, { type: "set_prop", nodeId: "t", key: "gap", value: 2 });
  replica.receive({ type: "welcome", doc: server, seq: 12 });
  const effects = replica.receive({ type: "rejected", opId: mine.opId, reason: "stale" });
  expect(replica.takeSendable().map((op) => op.opId)).not.toContain(mine.opId); // resending would put a seq-11 write on top of a seq-12 write
  expect(effects.rejected.map((r) => r.reason)).toEqual(["stale"]);
  expect(replica.doc.nodes["t"]?.props["gap"]).toBe(2);
});

test("'stale' for a never-sent op gives up after two tries and reports it", () => {
  const replica = ready();
  const out = queued(replica, add("a"));
  replica.receive({ type: "welcome", doc: emptyDoc(), seq: 0 });
  const stale: DocMessage = { type: "rejected", opId: out.opId, reason: "stale" };
  replica.receive(stale);
  replica.receive(stale);
  expect(replica.receive(stale).rejected).toEqual([{ opId: out.opId, op: add("a"), reason: "stale", quiet: false }]);
  expect(replica.doc.nodes["a"]).toBeUndefined();
});

test("someone else's op that carries MY opId is THEIR op: mine stays pending and the guess stays honest", () => {
  // Reachable: my op was applied and broadcast (so the id is public), I never heard, and I still hold it as pending.
  const replica = ready();
  const out = sent(replica, add("a"));
  replica.receive({ type: "op", seq: 1, opId: out.opId, actor: OTHER, op: add("z") });
  expect(replica.confirmed.nodes["z"]).toBeDefined();
  expect(replica.confirmed.nodes["a"]).toBeUndefined();
  expect(replica.pending.map((p) => p.opId)).toEqual([out.opId]);
  expect(replica.doc.nodes["root"]?.children).toEqual(["a", "z"]); // confirmed (z), then pending (a at index 0)
});

test("a welcome that is not a well-formed document is refused: it would hang the first move", () => {
  const replica = createReplica({ manifest });
  const loop = { component: "Stack", props: {}, children: [] };
  const doc: Doc = { rootId: "root", nodes: { root: { id: "root", component: "Root", props: {}, parentId: null, children: [] }, a: { ...loop, id: "a", parentId: "b" }, b: { ...loop, id: "b", parentId: "a" } } };
  expect(replica.receive({ type: "welcome", doc, seq: 1 }).fatal).toBe("document_corrupt");
  expect(replica.local(add("x"))).toEqual({ ok: false, reason: "not_ready" });
});

test("revision changes exactly when the visible document does", () => {
  const replica = ready();
  const start = replica.revision;
  const out = sent(replica, add("a"));
  const afterLocal = replica.revision;
  expect(afterLocal).toBeGreaterThan(start);
  replica.receive(ack(1, out)); // the guess already showed it
  replica.receive({ type: "rejected", opId: crypto.randomUUID(), reason: "gone" }); // not ours
  expect(replica.revision).toBe(afterLocal);
  replica.receive(remote(2, add("b")));
  expect(replica.revision).toBeGreaterThan(afterLocal);
});

test("the pending queue is capped: an offline peer cannot grow without limit", () => {
  const replica = createReplica({ manifest, maxPending: 2 });
  replica.receive({ type: "welcome", doc: emptyDoc(), seq: 0 });
  sent(replica, add("a"));
  sent(replica, add("b"));
  expect(replica.local(add("c"))).toEqual({ ok: false, reason: "too_many_pending" });
  expect(replica.doc.nodes["c"]).toBeUndefined();
});

test("at most `window` unanswered ops are on the wire; an answer lets the next one out, in order", () => {
  const replica = createReplica({ manifest, window: 2 });
  replica.receive({ type: "welcome", doc: emptyDoc(), seq: 0 });
  const [a, b, c] = [queued(replica, add("a")), queued(replica, add("b")), queued(replica, add("c"))];
  expect(replica.takeSendable()).toEqual([a, b]);
  expect(replica.takeSendable()).toEqual([]);
  replica.receive(ack(1, a));
  expect(replica.takeSendable()).toEqual([c]);
  expect(b.opId).not.toBe(c.opId);
});

test("'rate_limited': the op stays, sending pauses, then it and everything after it go out again in order", () => {
  const replica = ready();
  const [a, b, c] = [sent(replica, add("a")), sent(replica, add("b")), sent(replica, add("c"))];
  replica.receive(ack(1, a));
  const effects = replica.receive({ type: "rejected", opId: b.opId, reason: "rate_limited", retryAfterMs: 120 });
  expect(effects).toEqual({ rejected: [], resync: false, pauseMs: 120 });
  replica.receive({ type: "rejected", opId: c.opId, reason: "rate_limited", retryAfterMs: 1 });
  expect(replica.doc.nodes["c"]).toBeDefined(); // still shown: it is late, not refused
  expect(replica.takeSendable()).toEqual([b]); // carefully: one first
  replica.receive(ack(2, b));
  expect(replica.takeSendable()).toEqual([c]);
});

test("after 'rate_limited' the window restarts at ONE op and grows by one per answer: no burst into an empty budget", () => {
  const replica = createReplica({ manifest, window: 4 });
  replica.receive({ type: "welcome", doc: emptyDoc(), seq: 0 });
  const made = ["a", "b", "c", "d", "e", "f"].map((id) => queued(replica, add(id)));
  expect(replica.takeSendable()).toHaveLength(4);
  replica.receive({ type: "rejected", opId: made[0]?.opId ?? "", reason: "rate_limited", retryAfterMs: 10 });
  expect(replica.takeSendable().map((op) => op.opId)).toEqual([made[0]?.opId]); // one, not four
  replica.receive(ack(1, made[0] ?? queued(replica, add("x"))));
  expect(replica.takeSendable()).toHaveLength(2);
});

test("a pause the server asks for is capped: a hostile retryAfterMs cannot silence the client for weeks", () => {
  const replica = ready();
  const out = sent(replica, add("a"));
  expect(replica.receive({ type: "rejected", opId: out.opId, reason: "rate_limited", retryAfterMs: 2 ** 31 }).pauseMs).toBe(30_000);
});

test("an 'ack' is believed even if the op would change the document we hold NOW: the room judged it earlier, and a newer write stands", () => {
  // I set gap=2 when it already was 2 (a no-op; the ack is lost). Someone sets gap=1. I reconnect and
  // resend: the room answers from its memory, "ack". Not believing it was an endless resync.
  const replica = ready();
  sent(replica, add("n"));
  const server = emptyDoc();
  applyOpInto(server, add("n"));
  applyOpInto(server, { type: "set_prop", nodeId: "n", key: "gap", value: 1 });
  const mine = queued(replica, { type: "set_prop", nodeId: "n", key: "gap", value: 2 });
  replica.receive({ type: "welcome", doc: server, seq: 3 });
  const effects = replica.receive({ type: "ack", opId: mine.opId });
  expect(effects.resync).toBe(false);
  expect(replica.pending.map((p) => p.opId)).not.toContain(mine.opId);
  expect(replica.doc.nodes["n"]?.props["gap"]).toBe(1);
});

test("'ack' (the server found the op changed nothing) ends the wait and drops the guess", () => {
  const replica = ready();
  const out = sent(replica, add("a"));
  replica.receive(remote(1, add("a"))); // someone else added the very same node first
  replica.receive({ type: "ack", opId: out.opId });
  expect(replica.pending).toHaveLength(0);
  expect(replica.doc).toEqual(replica.confirmed);
});

test("a local edit that changes nothing is not queued or sent at all", () => {
  const replica = ready();
  sent(replica, add("n"));
  sent(replica, { type: "set_prop", nodeId: "n", key: "gap", value: 4 });
  const before = replica.revision;
  expect(replica.local({ type: "set_prop", nodeId: "n", key: "gap", value: 4 }).ok).toBe(true);
  expect(replica.pending).toHaveLength(2);
  expect(replica.revision).toBe(before);
});

// THE property (bead note 5). Whatever mix of local edits, remote edits, acknowledgements and
// refusals arrives, the optimistic document is ALWAYS exactly "confirmed, then every pending op",
// it is always well formed, and once nothing is pending it IS the server's document.
test.each(Array.from({ length: 60 }, (_, i) => i + 1))("rebase property, seed %i", (seed) => {
  const random = seeded(seed);
  const server = emptyDoc();
  let seq = 0;
  const appliedAt = new Map<string, number>(); // the server's dedupe memory: opId -> seq
  const replica = ready();
  let inFlight: ClientOp[] = [];
  /** The server handles the oldest in-flight op; `heard` = does the answer reach the replica? */
  const deliver = (heard: boolean): void => {
    const next = inFlight.shift();
    if (!next) return;
    const before = appliedAt.get(next.opId);
    let answer: DocMessage;
    if (before !== undefined) answer = ack(before, next); // a resend: the original answer, nothing applied
    else if (applyOpInto(server, next.op)) {
      appliedAt.set(next.opId, ++seq);
      answer = ack(seq, next);
    } else answer = { type: "rejected", opId: next.opId, reason: "gone" };
    if (heard) replica.receive(answer);
  };
  // rebuild() SHARES node objects between the two documents. That is only safe while nothing edits
  // a node in place, so every node the replica holds is frozen: an in-place edit would throw here.
  const freeze = (doc: Doc): void => { for (const node of Object.values(doc.nodes)) { Object.freeze(node); Object.freeze(node.props); Object.freeze(node.children); } };

  for (let step = 0; step < 150; step++) {
    const roll = random();
    if (roll < 0.4) {
      const result = replica.local(randomOp(random, replica.doc));
      if (result.ok) inFlight.push(...replica.takeSendable());
    } else if (roll < 0.65) {
      const op = randomOp(random, server);
      if (applyOpInto(server, op)) replica.receive(remote(++seq, op));
    } else if (roll < 0.9) deliver(true);
    else {
      // The connection dies: some answers are lost on the way, then a fresh welcome, then the resend.
      while (inFlight.length > 0 && random() < 0.5) deliver(false);
      replica.receive({ type: "welcome", doc: structuredClone(server), seq });
      inFlight = replica.takeSendable();
    }

    const expected = structuredClone(replica.confirmed);
    for (const pending of replica.pending) applyOpInto(expected, pending.op);
    expect(replica.doc).toEqual(expected);
    expect(checkDoc(replica.doc)).toEqual([]);
    freeze(replica.doc);
    freeze(replica.confirmed);
  }
  while (inFlight.length > 0) deliver(true);
  expect(replica.pending).toHaveLength(0);
  expect(replica.doc).toEqual(server);
});
