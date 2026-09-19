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
    constructor(url: string) { // no `readonly url` shorthand: a parameter property is code TypeScript GENERATES, which type stripping cannot do
      super();
      if (!url.startsWith("ws://")) throw new SyntaxError("invalid URL"); // as the real constructor does
      sockets.push(this);
      queueMicrotask(() => { onOpen(this, sockets.length); });
    }
    send(frame: string): void { this.sent.push(frame); }
    close(code = 1000): void { this.dispatchEvent(Object.assign(new Event("close"), { code })); }
    say(message: unknown): void { this.dispatchEvent(Object.assign(new Event("message"), { data: typeof message === "string" || message instanceof ArrayBuffer ? message : JSON.stringify(message) })); }
  }
  return { sockets, WebSocketImpl: FakeSocket as unknown as typeof WebSocket };
}
type FakeSocket = EventTarget & { sent: string[]; close(code?: number): void; say(message: unknown): void };

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
  net.sockets[0]?.say({ type: "presence", cursors: [] });
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
  await until(() => frames().length === 5, "the resend after the pause");
  expect(frames().slice(2).map((f) => f.op.nodeId)).toEqual(["a", "b", "c"]);
  expect(peer.status).toBe("live"); // slowed down, never disconnected
  peer.close();
});
