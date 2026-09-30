import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import { emptyDoc, ROOT_ID } from "@noon/doc-model";
import { signSessionToken } from "@noon/session-token";
import WebSocket from "ws";
import { startSyncServer } from "./server.ts";
import { decodeSnapshot } from "./snapshots.ts";
import { connect, memorySnapshots, NO_JOURNAL, TEST_ORG, TEST_SECRET, until } from "./testing.ts";

// Findings from the E2.3 review, reproduced with a store whose behaviour the test controls.
const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: ROOT_ID, index: 0, component: "Stack", props: {} });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeStore(over: Partial<DocumentStore> = {}): DocumentStore & { pointed: number[] } {
  const pointed: number[] = [];
  return {
    pointed,
    ...NO_JOURNAL,
    load: () => Promise.resolve({ doc: undefined, seq: 0, snapshotSeq: 0 }),
    snapshotted: (_org, _id, seq) => { pointed.push(seq); return Promise.resolve(); },
    ...over,
  };
}
const stored = (snapshots: ReturnType<typeof memorySnapshots>): Doc[] => [...snapshots.objects.values()].map((bytes) => decodeSnapshot(bytes) ?? emptyDoc());

test("a graceful shutdown SNAPSHOTS every open room before it returns", async () => {
  const store = fakeStore();
  const snapshots = memorySnapshots();
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store, snapshots });
  const peer = await connect(server.url, randomUUID());
  const opId = peer.send(add("unsaved"));
  await peer.next("op", (m) => m.opId === opId);

  await server.close(); // what SIGTERM runs; the peer is still connected
  expect(store.pointed).toEqual([1]);
  expect(stored(snapshots)[0]?.nodes["unsaved"]).toBeDefined();
});

test("a peer that goes away while its document is still loading does not leave a room behind", async () => {
  const store = fakeStore({ load: async () => { await sleep(150); return { doc: undefined, seq: 0, snapshotSeq: 0 }; } });
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store });
  for (let i = 0; i < 5; i++) {
    const peer = await connect(server.url, randomUUID());
    peer.close(); // gone before the load finishes
  }
  await until(() => server.roomCount() === 0, "rooms of vanished peers to be dropped", 3000);
  await server.close();
});

test("a database outage is 4503 'try again', not 4500 'your document is corrupt', and the next peer retries the load", async () => {
  let down = true;
  let loads = 0;
  // The first load does not finish until the test says so: all three peers below are then waiting on
  // that ONE load when it fails. (A fixed 80 ms delay was enough alone and too short inside `make check`.)
  let allConnected = (): void => undefined;
  const gate = new Promise<void>((resolve) => { allConnected = resolve; });
  const store = fakeStore({ load: async () => { loads++; await gate; if (down) throw new Error("connection refused"); return { doc: undefined, seq: 0, snapshotSeq: 0 }; } });
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store });
  const documentId = randomUUID();
  const peers = await Promise.all([connect(server.url, documentId), connect(server.url, documentId), connect(server.url, documentId)]);
  allConnected();
  expect((await Promise.all(peers.map((p) => p.closed))).map((c) => c.code)).toEqual([4503, 4503, 4503]); // every waiter, the same reason

  down = false;
  const later = await connect(server.url, documentId);
  expect((await later.next("welcome")).seq).toBe(0);
  expect(loads).toBe(2); // one shared load for the three, then a fresh one
  later.close();
  await server.close();
});

test("every peer waiting on one failed open gets the SAME reason (absent document: 4404)", async () => {
  const store = fakeStore({ load: async () => { await sleep(30); return undefined; } });
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store });
  const documentId = randomUUID();
  const peers = await Promise.all([1, 2, 3].map(() => connect(server.url, documentId)));
  expect((await Promise.all(peers.map((p) => p.closed))).map((c) => c.code)).toEqual([4404, 4404, 4404]);
  await server.close();
});

test("a last-leave snapshot that fails is not retried and names nothing: the room goes, the journal keeps the ops", async () => {
  const store = fakeStore();
  const snapshots = memorySnapshots();
  snapshots.fail = true;
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store, snapshots });
  const documentId = randomUUID();
  const peer = await connect(server.url, documentId);
  const opId = peer.send(add("kept"));
  await peer.next("op", (m) => m.opId === opId);
  peer.close();
  await until(() => server.roomCount() === 0, "the room to be dropped although its snapshot failed", 3000);
  await server.idle();
  expect(snapshots.objects.size).toBe(0);
  expect(store.pointed).toEqual([]); // Postgres never names a snapshot MinIO does not hold

  snapshots.fail = false; // the next room of the document snapshots as usual
  const again = await connect(server.url, documentId);
  const next = again.send(add("later"));
  await again.next("op", (m) => m.opId === next);
  again.close();
  await until(() => server.roomCount() === 0, "the room to be snapshotted and dropped", 3000);
  await server.idle();
  expect(store.pointed).toEqual([1]); // NO_JOURNAL keeps nothing, so this room started at 0 again
  await server.close();
});

test("the actor's kind and run come from the token: an agent's ops are attributed to the agent and its run", async () => {
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET] });
  const documentId = randomUUID();
  const token = signSessionToken({ userId: randomUUID(), orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60, actor: { kind: "agent", runId: "run-42" } });
  const watcher = await connect(server.url, documentId);
  const socket = new WebSocket(`${server.url}/documents/${documentId}`, ["noon.v1", token]);
  await new Promise<void>((resolve) => { socket.once("open", () => { resolve(); }); }); // listener attached before the event can fire
  socket.send(JSON.stringify({ type: "op", opId: randomUUID(), baseSeq: 0, op: add("by-the-agent") }));
  expect((await watcher.next("op")).actor).toMatchObject({ kind: "agent", runId: "run-42" });
  socket.close(); watcher.close();
  await server.close();
});
