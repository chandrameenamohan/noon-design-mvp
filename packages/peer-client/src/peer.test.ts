import { expect, test } from "vitest";
import type { Op, ServerMessage } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { emptyDoc } from "@noon/doc-model";
import { connectPeer, type PeerOptions, type Rejection } from "./index.ts";

// The transport against a server the test scripts by hand: every hostile or broken behaviour a real
// server could show, without needing one. (The real server is in apps/sync/src/peer-client.int.test.ts.)
const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 0, component: "Stack", props: {} });
const welcome: ServerMessage = { type: "welcome", doc: emptyDoc(), seq: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + 2000; !condition(); await sleep(5)) if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
}

/** A scripted server: `onOpen` runs for each new connection and may say anything, or nothing. */
function fakeNet(onOpen: (socket: FakeSocket, nth: number) => void) {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    sent: string[] = [];
    url: string;
    constructor(url: string) { // no `readonly url` shorthand: a parameter property is code TypeScript GENERATES, which type stripping cannot do
      super();
      if (!url.startsWith("ws://")) throw new SyntaxError("invalid URL"); // as the real constructor does
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => { onOpen(this, sockets.length); });
    }
    send(frame: string): void { this.sent.push(frame); }
    close(code = 1000): void { this.dispatchEvent(Object.assign(new Event("close"), { code })); }
    say(message: unknown): void { this.dispatchEvent(Object.assign(new Event("message"), { data: typeof message === "string" || message instanceof ArrayBuffer ? message : JSON.stringify(message) })); }
  }
  return { sockets, WebSocketImpl: FakeSocket as unknown as typeof WebSocket };
}
type FakeSocket = EventTarget & { sent: string[]; url: string; close(code?: number): void; say(message: unknown): void };

const options = (net: ReturnType<typeof fakeNet>, extra: Partial<PeerOptions> = {}): PeerOptions => ({
  manifest,
  session: () => Promise.resolve({ wsUrl: "ws://test/documents/d", token: "t" }),
  WebSocketImpl: net.WebSocketImpl,
  retryMs: { min: 10, max: 160 },
  ...extra,
});

test("a server that welcomes and then drops the peer, again and again, is retried SLOWER each time", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); socket.close(1006); });
  const peer = connectPeer(options(net));
  await sleep(600);
  peer.close();
  // With the pause reset by every welcome this was 60+ connections (one per ~10 ms). Growing to 160 ms: about ten.
  expect(net.sockets.length).toBeLessThan(16);
  expect(net.sockets.length).toBeGreaterThan(3);
});

test("the room's node dies, or says the room moved (4409): the next connection dials whatever /session answers NOW (F21)", async () => {
  const net = fakeNet((socket, nth) => {
    socket.say(welcome);
    if (nth === 1) socket.close(1006); // killed
    if (nth === 2) socket.close(4409); // not the owner (yet)
  });
  const addresses = ["ws://node-a/documents/d", "ws://node-b/documents/d", "ws://node-c/documents/d"];
  let asked = 0;
  const peer = connectPeer(options(net, { session: () => Promise.resolve({ wsUrl: addresses[Math.min(asked++, 2)] ?? "", token: "t" }) }));
  await until(() => net.sockets.length === 3 && peer.status === "live", "live on the third address");
  expect(net.sockets.map((socket) => socket.url)).toEqual(addresses);
  peer.close();
});

test("a connection that opens but never says welcome is given up on and replaced", async () => {
  const net = fakeNet((socket, nth) => { if (nth > 1) socket.say(welcome); });
  const peer = connectPeer(options(net, { ackTimeoutMs: 40 }));
  await until(() => peer.status === "live", "live on the second connection");
  expect(net.sockets).toHaveLength(2);
  peer.close();
});

test("frames this client cannot read are ignored: binary, not JSON, or a message type from a newer server", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  net.sockets[0]?.say(new ArrayBuffer(4));
  net.sockets[0]?.say("not json {");
  net.sockets[0]?.say({ type: "telepathy", thoughts: [] });
  net.sockets[0]?.say(null);
  expect(peer.status).toBe("live");
  peer.close();
});

test("a message of a KNOWN type that breaks the contract ends the peer: this server cannot be trusted", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  net.sockets[0]?.say({ type: "op", seq: "one" });
  expect(peer.closedBecause).toBe("protocol");
});

test("a malformed welcome document ends the peer, and the edits that will never be sent are reported", async () => {
  const lost: Rejection[] = [];
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net, { onRejected: (r) => lost.push(r) }));
  await until(() => peer.status === "live", "live");
  peer.submit(add("unsent"));
  const node = { component: "Stack", props: {}, children: [] };
  net.sockets[0]?.say({ type: "welcome", seq: 5, doc: { rootId: "root", nodes: { root: emptyDoc().nodes["root"], a: { ...node, id: "a", parentId: "b" }, b: { ...node, id: "b", parentId: "a" } } } });
  expect(peer.closedBecause).toBe("document_corrupt");
  expect(lost.map((r) => `${r.reason}:${r.op.nodeId}`)).toEqual(["connection_closed:unsent"]);
  expect(peer.pendingCount).toBe(0);
});

test("a frame from a connection that was already abandoned is ignored", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  net.sockets[0]?.close(1006);
  await until(() => net.sockets.length === 2 && peer.status === "live", "live again");
  net.sockets[1]?.say({ type: "op", seq: 1, opId: crypto.randomUUID(), actor: { kind: "user", id: "o" }, op: add("kept") });
  net.sockets[0]?.say(welcome); // late, from the dead connection: an EMPTY document at seq 0
  expect(peer.doc.nodes["kept"]).toBeDefined();
  peer.close();
});

test("a session whose URL cannot be opened is a reason to retry, not an unhandled rejection", async () => {
  let asked = 0;
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net, { session: () => Promise.resolve({ wsUrl: ++asked < 3 ? "nonsense" : "ws://test/documents/d", token: "t" }) }));
  await until(() => peer.status === "live", "live once the URL is good");
  expect(asked).toBe(3);
  peer.close();
});

test("callbacks never run before connectPeer has returned, and revision moves with the document", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const seen: string[] = [];
  const peer = connectPeer(options(net, { onStatus: () => seen.push(peer.status) })); // `peer` must already exist
  await until(() => peer.status === "live", "live");
  expect(seen).toEqual(["connecting", "live"]);
  const before = peer.revision;
  peer.submit(add("a"));
  expect(peer.revision).toBeGreaterThan(before);
  expect(JSON.parse(net.sockets[0]?.sent[0] ?? "{}")).toMatchObject({ type: "op", baseSeq: 0 });
  peer.close();
});

test("onChange also fires when only the pending count changes: 'saved' is news even if the picture is the same", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  let changes = 0;
  const peer = connectPeer(options(net, { onChange: () => changes++ }));
  await until(() => peer.status === "live", "live");
  peer.submit(add("a"));
  const before = changes;
  const frame = JSON.parse(net.sockets[0]?.sent[0] ?? "{}") as { opId: string; op: Op };
  net.sockets[0]?.say({ type: "op", seq: 1, opId: frame.opId, actor: { kind: "user", id: "me" }, op: frame.op });
  expect(peer.pendingCount).toBe(0);
  expect(changes).toBe(before + 1);
  net.sockets[0]?.say({ type: "rejected", opId: crypto.randomUUID(), reason: "gone" }); // not ours: nothing changed
  expect(changes).toBe(before + 1);
  peer.close();
});

test("'rate_limited' makes the transport WAIT, then send the refused op and its successors again, in order", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  peer.submit(add("a"));
  peer.submit(add("b"));
  const socket = net.sockets[0];
  const frames = (): { opId: string; op: { nodeId: string } }[] => (socket?.sent ?? []).map((f) => JSON.parse(f) as { opId: string; op: { nodeId: string } });
  const [a, b] = frames();
  socket?.say({ type: "rejected", opId: a?.opId, reason: "rate_limited", retryAfterMs: 80 });
  socket?.say({ type: "rejected", opId: b?.opId, reason: "rate_limited", retryAfterMs: 80 });
  peer.submit(add("c")); // made during the pause: it waits its turn
  await sleep(40);
  expect(frames()).toHaveLength(2);
  await until(() => frames().length === 3, "the first resend after the pause");
  expect(frames()[2]?.op.nodeId).toBe("a"); // one op first: the budget has refilled by about one token
  socket?.say({ type: "op", seq: 1, opId: a?.opId, actor: { kind: "user", id: "me" }, op: add("a") });
  expect(frames().slice(3).map((f) => f.op.nodeId)).toEqual(["b", "c"]); // an answer widens the window again
  expect(peer.status).toBe("live"); // slowed down, never disconnected
  peer.close();
});

test("a reject reason this client has never heard of is 'not applied, come back later', never the end of the peer", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  peer.submit(add("a"));
  const sentOp = JSON.parse(net.sockets[0]?.sent[0] ?? "{}") as { opId: string };
  net.sockets[0]?.say({ type: "rejected", opId: sentOp.opId, reason: "a_reason_from_next_year" });
  expect(peer.closedBecause).toBeUndefined();
  expect(peer.pendingCount).toBe(1);
  await until(() => net.sockets.length === 2, "a reconnect, which resends it");
  peer.close();
});

test("the watchdog leaves a pause alone: waiting as the server asked is not a dead connection", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net, { ackTimeoutMs: 40 }));
  await until(() => peer.status === "live", "live");
  peer.submit(add("a"));
  const sentOp = JSON.parse(net.sockets[0]?.sent[0] ?? "{}") as { opId: string };
  net.sockets[0]?.say({ type: "rejected", opId: sentOp.opId, reason: "rate_limited", retryAfterMs: 250 });
  await sleep(200);
  expect(net.sockets).toHaveLength(1);
  peer.close();
});

test("edits that change nothing do not reset the silence clock: a dead connection is still noticed", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net, { ackTimeoutMs: 60 }));
  await until(() => peer.status === "live", "live");
  peer.submit(add("a")); // never answered
  const fidget = setInterval(() => { peer.submit({ type: "move_node", nodeId: "a", newParentId: "root", index: 0 }); }, 15); // a drag that goes nowhere
  await until(() => net.sockets.length === 2, "the reconnect");
  clearInterval(fidget);
  peer.close();
});

test("close() right after connectPeer() wins: the connection that had not started yet never starts", async () => {
  // Exactly what React's StrictMode does in development: mount, clean up, mount again, in one tick.
  const net = fakeNet((socket) => { socket.say(welcome); });
  let asked = 0;
  const peer = connectPeer(options(net, { session: () => { asked++; return Promise.resolve({ wsUrl: "ws://test/documents/d", token: "t" }); } }));
  peer.close();
  await sleep(50);
  expect(asked).toBe(0);
  expect(net.sockets).toHaveLength(0);
  expect(peer.status).toBe("closed");
});

// --- presence ------------------------------------------------------------------------------------
const ada = { peerId: "p7", actor: { kind: "user", id: "u-ada" }, name: "Ada", cursor: { x: 0.5, y: 0.5 }, selection: null } as const;
const framesOf = (socket: FakeSocket | undefined, type: string): Record<string, unknown>[] => (socket?.sent ?? []).map((f) => JSON.parse(f) as Record<string, unknown>).filter((f) => f["type"] === type);

test("others: who the welcome says is here, then every presence message, until they leave", async () => {
  const net = fakeNet((socket) => { socket.say({ ...welcome, you: "p1", peers: [ada] }); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  expect(peer.others.map((p) => p.name)).toEqual(["Ada"]);
  const before = peer.presenceRevision;
  net.sockets[0]?.say({ type: "presence", ...ada, selection: "n1" });
  net.sockets[0]?.say({ type: "presence", ...ada, peerId: "p9", name: "Bob" });
  expect(peer.others.map((p) => [p.name, p.selection])).toEqual([["Ada", "n1"], ["Bob", null]]);
  expect(peer.presenceRevision).toBeGreaterThan(before);
  net.sockets[0]?.say({ type: "presence_left", peerId: "p7" });
  expect(peer.others.map((p) => p.name)).toEqual(["Bob"]);
  peer.close();
});

test("onOp hears every op the room orders, with the actor the room stamped on it: what a view of who-did-what keys on (E10.6)", async () => {
  const net = fakeNet((socket) => { socket.say({ ...welcome, you: "p1", peers: [] }); });
  const heard: { seq: number; actor: string; nodeId: string }[] = [];
  const peer = connectPeer(options(net, { onOp: (message) => { heard.push({ seq: message.seq, actor: message.actor.kind, nodeId: message.op.nodeId }); } }));
  await until(() => peer.status === "live", "live");
  net.sockets[0]?.say({ type: "op", seq: 1, opId: crypto.randomUUID(), actor: { kind: "agent", id: "worker", runId: "r" }, op: add("card") });
  net.sockets[0]?.say({ type: "op", seq: 2, opId: crypto.randomUUID(), actor: { kind: "user", id: "o" }, op: { type: "set_prop", nodeId: "card", key: "gap", value: 8 } });
  expect(heard).toEqual([{ seq: 1, actor: "agent", nodeId: "card" }, { seq: 2, actor: "user", nodeId: "card" }]);
  expect(peer.doc.nodes["card"]).toBeDefined(); // told AFTER the op is applied: a listener may read the document it changed
  peer.close();
});

test("someone who goes silent is forgotten: a dead connection never says goodbye", async () => {
  const net = fakeNet((socket) => { socket.say({ ...welcome, you: "p1", peers: [ada] }); });
  const peer = connectPeer(options(net, { presence: { sendEveryMs: 10, refreshMs: 40, forgetAfterMs: 120 } }));
  await until(() => peer.status === "live", "live");
  await sleep(60);
  net.sockets[0]?.say({ type: "presence", ...ada }); // a refresh keeps her
  await sleep(80);
  expect(peer.others).toHaveLength(1);
  await until(() => peer.others.length === 0, "Ada to be forgotten");
  peer.close();
});

test("our own presence: the latest state only, not more often than allowed, refreshed while idle, sent again after a reconnect", async () => {
  const net = fakeNet((socket) => { socket.say({ ...welcome, you: "p1", peers: [] }); });
  const peer = connectPeer(options(net, { presence: { sendEveryMs: 40, refreshMs: 100, forgetAfterMs: 5000 } }));
  await until(() => peer.status === "live", "live");
  for (let i = 0; i <= 20; i++) peer.setPresence({ cursor: { x: i / 20, y: 0 }, selection: null }); // a fast pointer
  await sleep(70);
  const sent = framesOf(net.sockets[0], "presence");
  expect(sent.length).toBeLessThanOrEqual(2); // the first at once, the LAST one after the interval; never 21
  expect(sent.at(-1)).toEqual({ type: "presence", cursor: { x: 1, y: 0 }, selection: null });

  await until(() => framesOf(net.sockets[0], "presence").length > sent.length, "a refresh while idle");

  net.sockets[0]?.close(1006);
  await until(() => net.sockets.length === 2 && peer.status === "live", "live again");
  await until(() => framesOf(net.sockets[1], "presence").length > 0, "presence on the new connection");
  expect(framesOf(net.sockets[1], "presence")[0]).toEqual({ type: "presence", cursor: { x: 1, y: 0 }, selection: null });
  peer.close();
});

test("a peer that never calls setPresence sends none: the AI worker and the git peer have no pointer", async () => {
  const net = fakeNet((socket) => { socket.say({ ...welcome, you: "p1", peers: [] }); });
  const peer = connectPeer(options(net, { presence: { sendEveryMs: 10, refreshMs: 20, forgetAfterMs: 5000 } }));
  await until(() => peer.status === "live", "live");
  await sleep(80);
  expect(framesOf(net.sockets[0], "presence")).toEqual([]);
  peer.close();
});

test("presence is cosmetic: a malformed presence frame is skipped, it does not end the session", async () => {
  const net = fakeNet((socket) => { socket.say({ ...welcome, you: "p1", peers: [] }); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  peer.submit(add("unsaved"));
  net.sockets[0]?.say({ type: "presence", ...ada, cursor: { x: "left", y: 0 } });
  net.sockets[0]?.say({ type: "presence_left" });
  expect(peer.status).toBe("live");
  expect(peer.pendingCount).toBe(1);
  peer.close();
});

test("after a reconnect we never see OURSELVES: the room may not know yet that our old connection is dead", async () => {
  const net = fakeNet((socket, nth) => {
    socket.say(nth === 1 ? { ...welcome, you: "old-me", peers: [] } : { ...welcome, you: "new-me", peers: [{ ...ada, peerId: "old-me", name: "Me" }, ada] });
  });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  net.sockets[0]?.close(1006);
  await until(() => net.sockets.length === 2 && peer.status === "live", "live again");
  expect(peer.others.map((p) => p.name)).toEqual(["Ada"]);
  net.sockets[1]?.say({ type: "presence", ...ada, peerId: "old-me", name: "Me" }); // and not later either
  expect(peer.others.map((p) => p.name)).toEqual(["Ada"]);
  peer.close();
});

// --- E3.2: the per-op outcome ---------------------------------------------------------------------
test("submit().settled resolves with what the SERVER decided about that op, and confirmed/seq show only what the server said", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  const server = net.sockets[0];
  if (!server) throw new Error("unreachable");
  const sentOp = (n: number) => JSON.parse(server.sent[n] ?? "null") as { opId: string; op: Op };

  const first = peer.submit(add("a"));
  const second = peer.submit(add("b"));
  if (!first.ok || !second.ok) throw new Error("unreachable");
  expect(peer.doc.nodes["a"]).toBeDefined(); // the guess
  expect(peer.confirmed.nodes["a"]).toBeUndefined(); // not yet a fact
  expect(peer.seq).toBe(0);

  await until(() => server.sent.length === 2, "both ops on the wire");
  server.say({ type: "op", seq: 1, opId: sentOp(0).opId, actor: { kind: "agent", id: "me", runId: "r" }, op: sentOp(0).op });
  server.say({ type: "rejected", opId: sentOp(1).opId, reason: "document_limit" });
  expect(await first.settled).toEqual({ ok: true, seq: 1 });
  expect(await second.settled).toEqual({ ok: false, reason: "document_limit" });
  expect(peer.confirmed.nodes["a"]).toBeDefined();
  expect(peer.confirmed.nodes["b"]).toBeUndefined();
  expect(peer.seq).toBe(1);

  const same = peer.submit({ type: "set_prop", nodeId: "a", key: "gap", value: null }); // changes nothing: never sent
  if (!same.ok) throw new Error("unreachable");
  expect(await same.settled).toEqual({ ok: true });
  expect(server.sent).toHaveLength(2);

  const refusedHere = peer.submit(add("a")); // the replica itself says no: there is nothing to wait for
  expect(refusedHere).toEqual({ ok: false, reason: "duplicate_node" });

  const lost = peer.submit(add("c"));
  if (!lost.ok) throw new Error("unreachable");
  peer.close();
  expect(await lost.settled).toEqual({ ok: false, reason: "connection_closed" });
});

test("a closed peer accepts nothing: submit() after close() is refused at once, changes nothing and leaves nobody waiting", async () => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  peer.close();
  // Before the fix this returned ok, edited the closed peer's document and handed out a promise that never settled.
  expect(peer.submit(add("late"))).toEqual({ ok: false, reason: "not_ready" });
  expect(peer.doc.nodes["late"]).toBeUndefined();
  expect(peer.pendingCount).toBe(0);
});

// --- E6.1b: a room whose storage is down is read-only; the peer holds its edits until it is writable --------
const readOnlyPeer = async (extra: Partial<PeerOptions> = {}) => {
  const net = fakeNet((socket) => { socket.say(welcome); });
  const peer = connectPeer(options(net, extra));
  await until(() => peer.status === "live", "live");
  const socket = net.sockets[0];
  const frames = (): { opId: string; op: { nodeId: string } }[] => (socket?.sent ?? []).map((f) => JSON.parse(f) as { opId: string; op: { nodeId: string } }).filter((f) => "op" in f);
  return { net, peer, socket, frames };
};

test("read-only: ops the room refused are HELD (no reconnect, nothing lost), new edits are refused 'read_only', and 'writable' sends the held ones again, in order, with the same opIds", async () => {
  let changes = 0;
  const { net, peer, socket, frames } = await readOnlyPeer({ onChange: () => { changes++; } });
  peer.submit(add("a"));
  peer.submit(add("b"));
  const [a, b] = frames();
  const before = changes;
  socket?.say({ type: "status", readOnly: true });
  expect(peer.readOnly).toBe(true);
  expect(changes).toBeGreaterThan(before); // a UI hears of it
  socket?.say({ type: "rejected", opId: a?.opId, reason: "unavailable" });
  socket?.say({ type: "rejected", opId: b?.opId, reason: "unavailable" });
  expect(peer.submit(add("c"))).toEqual({ ok: false, reason: "read_only" });
  await sleep(50);
  expect(net.sockets).toHaveLength(1); // no resync: the room said why, and will say when
  expect(peer.pendingCount).toBe(2);
  expect(peer.doc.nodes["a"]).toBeDefined(); // the user still sees what they made
  expect(frames()).toHaveLength(2); // nothing is sent into a read-only room
  socket?.say({ type: "status", readOnly: false });
  expect(peer.readOnly).toBe(false);
  expect(frames().slice(2).map((f) => f.opId)).toEqual([a?.opId, b?.opId]);
  peer.close();
});

test("read-only: a held op the room REPLAYS on recovery (its append had landed) is confirmed, not sent again", async () => {
  const { peer, socket, frames } = await readOnlyPeer();
  const submitted = peer.submit(add("a"));
  const [a] = frames();
  socket?.say({ type: "status", readOnly: true });
  socket?.say({ type: "rejected", opId: a?.opId, reason: "unavailable" });
  socket?.say({ type: "op", seq: 1, opId: a?.opId, actor: { kind: "user", id: "me" }, op: add("a") });
  socket?.say({ type: "status", readOnly: false });
  expect(frames()).toHaveLength(1);
  expect(peer.pendingCount).toBe(0);
  expect(submitted.ok && (await submitted.settled)).toEqual({ ok: true, seq: 1 });
  peer.close();
});

test("read-only: a welcome that says so starts the peer read-only, and edits are refused until 'writable'", async () => {
  const net = fakeNet((socket) => { socket.say({ ...welcome, readOnly: true }); });
  const peer = connectPeer(options(net));
  await until(() => peer.status === "live", "live");
  expect(peer.readOnly).toBe(true);
  expect(peer.submit(add("x"))).toEqual({ ok: false, reason: "read_only" });
  net.sockets[0]?.say({ type: "status", readOnly: false });
  expect(peer.submit(add("a")).ok).toBe(true);
  expect(net.sockets[0]?.sent.filter((f) => f.includes('"add_node"'))).toHaveLength(1);
  peer.close();
});

test("read-only: the watchdog leaves held ops alone: a room that said it is read-only is not a dead connection", async () => {
  const { net, peer, socket, frames } = await readOnlyPeer({ ackTimeoutMs: 40 });
  peer.submit(add("a"));
  socket?.say({ type: "status", readOnly: true });
  socket?.say({ type: "rejected", opId: frames()[0]?.opId, reason: "unavailable" });
  await sleep(200);
  expect(net.sockets).toHaveLength(1);
  peer.close();
});

test("read-only ends with the connection: offline, an edit is queued as usual, and a new welcome without the flag is writable", async () => {
  const net = fakeNet((socket, nth) => { socket.say(nth === 1 ? { ...welcome, readOnly: true } : welcome); });
  const peer = connectPeer(options(net));
  await until(() => peer.readOnly, "read-only");
  net.sockets[0]?.close(1006);
  expect(peer.readOnly).toBe(false);
  expect(peer.submit(add("a")).ok).toBe(true); // it belonged to that room: offline edits wait for the next one
  await until(() => net.sockets.length === 2 && peer.status === "live", "live again");
  expect(peer.readOnly).toBe(false);
  peer.close();
});
