import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { SequencedOp, type Role } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import type { Leases } from "@noon/lease";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { startSyncServer, type RunningSyncServer } from "./server.ts";

// Opening a document against a fake store, so that how the store fails or how slowly it answers is the test's to
// choose. No Postgres: what the real one does is in resilience.int.test.ts and persistence.int.test.ts.
let server: RunningSyncServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

// Not testing.ts's: importing it needs Redis's password, and a unit test has no Redis.
const SECRET = "test-only-session-secret-0123456789abcdef";
const ORG = "22222222-2222-4222-8222-222222222222";
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
/** An empty document whose journal holds nothing, unless `over` says otherwise. */
const fakeStore = (over: Partial<DocumentStore> = {}): DocumentStore => ({
  load: () => Promise.resolve({ doc: undefined, seq: 0, snapshotSeq: 0 }),
  fence: () => Promise.resolve(0), claim: () => Promise.resolve(true), append: () => Promise.resolve(undefined), find: () => Promise.resolve(undefined),
  everAdded: () => Promise.resolve(false), since: () => Promise.resolve([]), snapshotted: () => Promise.resolve(),
  ...over,
});
const session = (documentId: string): { wsUrl: string; token: string } => ({
  wsUrl: `${server?.url ?? ""}/documents/${documentId}`,
  token: signSessionToken({ userId: randomUUID(), orgId: ORG, documentId, secret: SECRET, ttlSeconds: 60 }),
});
/** The close code a peer of a fresh document is sent away with, by a server with these options. */
const closeCodeWith = async (options: Omit<Parameters<typeof startSyncServer>[0], "port" | "secrets">): Promise<number> => {
  server = await startSyncServer({ port: 0, secrets: [SECRET], journalTimeoutMs: 100, ...options });
  const { wsUrl, token } = session(randomUUID());
  const socket = new WebSocket(wsUrl, ["noon.v1", token]);
  socket.on("error", () => undefined);
  return new Promise((resolve) => { socket.on("close", (code) => { resolve(code); }); });
};
const closeCodeOf = (store: DocumentStore): Promise<number> => closeCodeWith({ store });

// noon-mo3.3.4: the room's own journal calls were bounded, the load's were not: a Postgres that took the query and
// never answered held every peer of the document for ever, with no "try again".
test("a load that never answers is 'try again' (4503) within the journal bound, not a wait for ever", async () => {
  expect(await closeCodeOf(fakeStore({ load: never }))).toBe(4503);
});
test("a replay of the journal that never answers is 'try again' (4503) within the journal bound", async () => {
  expect(await closeCodeOf(fakeStore({ since: never }))).toBe(4503);
});

// noon-mo3.1.2: since() runs every row through the contract. A row that no longer passes it (corrupted, or written
// before a schema change) made since() reject, and the open answered 4503 "try again" with nothing logged: every
// later open did the same, for ever. It is damage, as a malformed snapshot is: 4500, logged. A failed query stays 4503.
test("a journal row the contract refuses is a corrupt document (4500), logged", async () => {
  const refused = SequencedOp.safeParse({ seq: 1, op: { type: "no_such_op" } });
  if (refused.success) throw new Error("the row was meant to be refused");
  expect(await closeCodeOf(fakeStore({ since: () => Promise.reject(refused.error) }))).toBe(4500);
});
test("a journal query that fails is still 'try again' (4503)", async () => {
  expect(await closeCodeOf(fakeStore({ since: () => Promise.reject(new Error("connection terminated")) }))).toBe(4503);
});

// noon-cs6.3.2 (Z.3 finding 2): opening is about six Postgres answers in a row (the role before the upgrade and again
// after it, fence, claim, load, the journal since the snapshot), and the client gives up on a connection that has
// said nothing for ackTimeoutMs (10 s), then dials again. At 4 s per answer a document never opened. While the room
// loads, the node now says "loading" every loadingEveryMs, and the client's silence clock sees a live node.
// Here: four answers of 200 ms each (800 ms) against a client that gives up after 400 ms of silence.
test("a slow open keeps the client's silence watchdog quiet: one connection, then live", async () => {
  const slow = <T>(value: T) => (): Promise<T> => new Promise((resolve) => { setTimeout(() => { resolve(value); }, 200); });
  server = await startSyncServer({
    port: 0, secrets: [SECRET], roles: slow<Role | undefined>("editor"), loadingEveryMs: 100,
    store: fakeStore({ load: slow({ doc: undefined, seq: 0, snapshotSeq: 0 }), since: slow([]) }),
  });
  const documentId = randomUUID();
  let dialled = 0;
  class Counted extends globalThis.WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      dialled++;
    }
  }
  const peer = connectPeer({ manifest, session: () => Promise.resolve(session(documentId)), WebSocketImpl: Counted, ackTimeoutMs: 400 });
  try {
    for (const deadline = Date.now() + 4000; peer.status !== "live"; await new Promise((resolve) => setTimeout(resolve, 20))) {
      if (Date.now() > deadline) throw new Error(`not live after 4 s (status ${peer.status}, ${String(dialled)} connections)`);
    }
    expect(dialled).toBe(1); // without the frames: a resync at 400 ms, and a third or fourth try before the room opens
  } finally {
    peer.close();
  }
});

/** Leases that always grant the room, unless `over` says otherwise. */
const fakeLeases = (over: Partial<Leases> = {}): Leases => ({
  ttlMs: 10_000,
  acquire: (_documentId, nodeId) => Promise.resolve({ acquired: true, holder: { token: 1, nodeId } }),
  renew: () => Promise.resolve(true), release: () => Promise.resolve(), owner: () => Promise.resolve(undefined),
  beat: () => Promise.resolve(), alive: () => Promise.resolve(new Set()), ready: () => Promise.resolve(), close: () => Promise.resolve(),
  ...over,
});

// noon-cs6.3.2: with "loading" frames keeping the client's watchdog quiet, a read that hangs for good held the peer
// for ever, where it used to redial after 10 s and reach another node. Every database read of an open is bounded.
test("a fence read that never answers is 'try again' (4503) within the journal bound", async () => {
  expect(await closeCodeWith({ store: fakeStore({ fence: never }), lease: { leases: fakeLeases(), nodeId: "node-a" } })).toBe(4503);
});
test("a claim that never answers is 'try again' (4503) within the journal bound", async () => {
  expect(await closeCodeWith({ store: fakeStore({ claim: never }), lease: { leases: fakeLeases(), nodeId: "node-a" } })).toBe(4503);
});
test("a role read before the upgrade that never answers is 'try again' (4503) within the journal bound", async () => {
  expect(await closeCodeWith({ store: fakeStore(), roles: never })).toBe(4503);
});

// noon-cs6.3.2: and whatever else takes that long (a dead node's lease, Redis), "loading" stops after loadingForMs: the client's
// silence clock runs again and it dials anew, perhaps another node.
test("an open that hangs for good stops saying 'loading' after loadingForMs", async () => {
  server = await startSyncServer({
    port: 0, secrets: [SECRET], store: fakeStore(), loadingEveryMs: 20, loadingForMs: 200,
    // Held by a dead node: the open waits its lease out, a whole ttl (10 s).
    lease: { leases: fakeLeases({ acquire: () => Promise.resolve({ acquired: false, holder: { token: 1, nodeId: "dead-node" } }) }), nodeId: "node-a" },
  });
  const { wsUrl, token } = session(randomUUID());
  const socket = new WebSocket(wsUrl, ["noon.v1", token]);
  socket.on("error", () => undefined);
  const started = performance.now();
  let last = 0;
  socket.on("message", () => { last = performance.now() - started; });
  await new Promise((resolve) => setTimeout(resolve, 600));
  socket.close();
  expect(last).toBeGreaterThan(0);
  expect(last).toBeLessThan(400);
});
