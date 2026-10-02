import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import type { DocumentStore } from "@noon/db";
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
/** The close code a peer of a fresh document is sent away with. */
const closeCodeOf = async (store: DocumentStore): Promise<number> => {
  server = await startSyncServer({ port: 0, secrets: [SECRET], store, journalTimeoutMs: 100 });
  const { wsUrl, token } = session(randomUUID());
  const socket = new WebSocket(wsUrl, ["noon.v1", token]);
  socket.on("error", () => undefined);
  return new Promise((resolve) => { socket.on("close", (code) => { resolve(code); }); });
};

// noon-mo3.3.4: the room's own journal calls were bounded, the load's were not: a Postgres that took the query and
// never answered held every peer of the document for ever, with no "try again".
test("a load that never answers is 'try again' (4503) within the journal bound, not a wait for ever", async () => {
  expect(await closeCodeOf(fakeStore({ load: never }))).toBe(4503);
});
test("a replay of the journal that never answers is 'try again' (4503) within the journal bound", async () => {
  expect(await closeCodeOf(fakeStore({ since: never }))).toBe(4503);
});
