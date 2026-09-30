import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { connectPeer, type PeerOptions, type PeerStatus } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { startSyncServer } from "./server.ts";
import { connect, NO_JOURNAL, TEST_ORG, TEST_SECRET, until, useSyncServer } from "./testing.ts";

// The REAL client against the REAL server: what a browser tab, the AI worker and the git peer all run.
const ctx = useSyncServer();
const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: ROOT_ID, index: 0, component: "Stack", props: {} });

/** A WebSocket the test can sabotage: go deaf (frames arrive, the client never hears them) or drop dead. */
function sabotage() {
  const sockets: WebSocket[] = [];
  let deaf = false;
  class Sabotaged extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
      // Capture phase of our own listener runs first because it is added first.
      this.addEventListener("message", (event) => { if (deaf) event.stopImmediatePropagation(); });
    }
  }
  return { WebSocketImpl: Sabotaged, sockets, goDeaf: () => { deaf = true; }, hearAgain: () => { deaf = false; }, drop: () => { sockets.at(-1)?.close(); } };
}

function peerFor(url: string, documentId: string, extra: Partial<PeerOptions> = {}) {
  const statuses: PeerStatus[] = [];
  const userId = randomUUID();
  const peer = connectPeer({
    manifest,
    // A fresh token for every connection, exactly as the api's /session route would give.
    session: () => Promise.resolve({ wsUrl: `${url}/documents/${documentId}`, token: signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60 }) }),
    onStatus: (status) => statuses.push(status),
    retryMs: { min: 20, max: 100 },
    ...extra,
  });
  return { peer, statuses };
}

test("two peers: an edit made in one shows up in the other", async () => {
  const documentId = randomUUID();
  const a = peerFor(ctx.server.url, documentId);
  const b = peerFor(ctx.server.url, documentId);
  await until(() => a.peer.status === "live" && b.peer.status === "live", "both peers live");

  expect(a.peer.submit(add("from-a")).ok).toBe(true);
  expect(a.peer.doc.nodes["from-a"]).toBeDefined(); // at once, optimistically
  await until(() => b.peer.doc.nodes["from-a"] !== undefined, "the node to reach the other peer");
  await until(() => a.peer.pendingCount === 0, "the acknowledgement");
  a.peer.close();
  b.peer.close();
});

test("an op whose acknowledgement was LOST is resent after the drop and lands exactly once", async () => {
  const documentId = randomUUID();
  const net = sabotage();
  const { peer, statuses } = peerFor(ctx.server.url, documentId, { WebSocketImpl: net.WebSocketImpl });
  const observer = await connect(ctx.server.url, documentId);
  await until(() => peer.status === "live", "peer live");

  net.goDeaf();
  peer.submit(add("once"));
  await observer.next("op", (m) => m.op.nodeId === "once"); // the server HAS applied it
  expect(peer.pendingCount).toBe(1); // ...but the peer never heard
  net.hearAgain();
  net.drop();

  await until(() => peer.pendingCount === 0, "the resend to be answered");
  expect(statuses).toEqual(["connecting", "live", "offline", "connecting", "live"]);
  expect(net.sockets).toHaveLength(2);
  expect(peer.doc.nodes[ROOT_ID]?.children).toEqual(["once"]);
  observer.send(add("marker"));
  await observer.next("op", (m) => m.op.nodeId === "marker");
  expect(observer.inbox.filter((m) => m.type === "op").map((m) => m.seq)).toEqual([1, 2]); // no second copy was sequenced
  peer.close();
  observer.close();
});

test("edits made while offline are kept, shown, and sent once the connection is back", async () => {
  const documentId = randomUUID();
  const net = sabotage();
  let online = true;
  const userId = randomUUID();
  const peer = connectPeer({
    manifest,
    WebSocketImpl: net.WebSocketImpl,
    retryMs: { min: 20, max: 50 },
    session: () => (online ? Promise.resolve({ wsUrl: `${ctx.server.url}/documents/${documentId}`, token: signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60 }) }) : Promise.reject(new Error("offline"))),
  });
  await until(() => peer.status === "live", "peer live");
  online = false;
  net.drop();
  await until(() => peer.status === "offline", "peer offline");

  expect(peer.submit(add("first")).ok).toBe(true);
  expect(peer.submit({ type: "add_node", nodeId: "second", parentId: "first", index: 0, component: "Stack", props: {} }).ok).toBe(true); // depends on the first
  expect(peer.doc.nodes["second"]?.parentId).toBe("first");

  online = true;
  await until(() => peer.pendingCount === 0, "both edits acknowledged");
  const observer = await connect(ctx.server.url, documentId);
  expect((await observer.next("welcome")).doc.nodes["second"]?.parentId).toBe("first");
  peer.close();
  observer.close();
});

test("a refusal from the server rolls the edit back and reports the reason", async () => {
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], limits: { maxNodes: 2 } }); // the root + one
  const rejected: string[] = [];
  const { peer } = peerFor(server.url, randomUUID(), { onRejected: (r) => rejected.push(`${r.reason}:${r.op.nodeId}`) });
  await until(() => peer.status === "live", "peer live");
  peer.submit(add("fits"));
  peer.submit(add("too-many")); // fine by the document's rules; only the ROOM knows its limit
  await until(() => peer.pendingCount === 0, "both answered");
  expect(rejected).toEqual(["document_limit:too-many"]);
  expect(Object.keys(peer.doc.nodes).sort()).toEqual(["fits", ROOT_ID]);
  peer.close();
  await server.close();
});

test("a close code that means 'do not retry' ends the peer instead of reconnecting for ever", async () => {
  const gone = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store: { ...NO_JOURNAL, load: () => Promise.resolve(undefined), save: () => Promise.resolve() } });
  const net = sabotage();
  const { peer, statuses } = peerFor(gone.url, randomUUID(), { WebSocketImpl: net.WebSocketImpl });
  await until(() => peer.status === "closed", "peer closed");
  await new Promise((resolve) => setTimeout(resolve, 150)); // several retry periods
  expect(net.sockets).toHaveLength(1);
  expect(statuses).toEqual(["connecting", "closed"]);
  expect(peer.closedBecause).toBe("4404");
  await gone.close();
});

test("a server that stops answering is noticed: the peer reconnects instead of waiting for ever", async () => {
  const documentId = randomUUID();
  const net = sabotage();
  const { peer } = peerFor(ctx.server.url, documentId, { WebSocketImpl: net.WebSocketImpl, ackTimeoutMs: 100 });
  await until(() => peer.status === "live", "peer live");
  net.goDeaf(); // the socket stays open; nothing is ever heard again on it
  peer.submit(add("patient"));
  setTimeout(net.hearAgain, 150);
  await until(() => peer.pendingCount === 0, "the op to be acknowledged on a NEW connection");
  expect(net.sockets.length).toBeGreaterThan(1);
  peer.close();
});

test("close() is final: no reconnect, and the server sees the peer leave", async () => {
  const documentId = randomUUID();
  const net = sabotage();
  const { peer } = peerFor(ctx.server.url, documentId, { WebSocketImpl: net.WebSocketImpl });
  await until(() => peer.status === "live", "peer live");
  peer.close();
  await until(() => ctx.server.peerCount(documentId) === 0, "the server to see it leave");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(net.sockets).toHaveLength(1);
  expect(peer.status).toBe("closed");
});
