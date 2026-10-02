import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import WebSocket from "ws";
import type { Holder, Leases } from "@noon/lease";
import { signSessionToken } from "@noon/session-token";
import { startSyncServer } from "./server.ts";

// testing.ts reaches for Redis's password at import: a unit test signs its own token.
const SECRET = "test-only-session-secret-0123456789abcdef";
const ORG = "22222222-2222-4222-8222-222222222222";
/** A peer, listening from the start: the welcome can arrive in the same packet as the upgrade's answer. */
const dial = (url: string, documentId: string): { welcomed: Promise<unknown>; closed: Promise<number> } => {
  const ws = new WebSocket(`${url}/documents/${documentId}`, ["noon.v1", signSessionToken({ userId: randomUUID(), orgId: ORG, documentId, secret: SECRET, ttlSeconds: 60 })]);
  ws.on("error", () => undefined);
  return { welcomed: new Promise((resolve) => ws.once("message", resolve)), closed: new Promise((resolve) => ws.once("close", resolve)) };
};

// noon-98h.1.1: close() waits for every room still opening. One waiting out a dead holder's lease (takeLease polls up
// to a ttl and a tenth) held it past main.ts's 8 s forced exit, so the rooms already open were never snapshotted
// and their leases never let go: the next owner waited a whole ttl for each. A closing node now gives that wait up.
test("a shutdown is not held up by a room waiting out a dead node's lease, and still lets go of the open ones", async () => {
  const free = randomUUID();
  const heldByTheDead = randomUUID();
  const asked = new Set<string>();
  const released: string[] = [];
  const leases: Leases = {
    ttlMs: 10_000,
    acquire: (documentId, nodeId) => {
      asked.add(documentId);
      const holder: Holder = documentId === free ? { token: 1, nodeId } : { token: 1, nodeId: "dead-node" };
      return Promise.resolve({ acquired: documentId === free, holder });
    },
    renew: () => Promise.resolve(true),
    release: (documentId) => { released.push(documentId); return Promise.resolve(); },
    owner: () => Promise.resolve(undefined),
    beat: () => Promise.resolve(),
    alive: () => Promise.resolve(new Set()), // the holder is dead: its lease can only expire
    ready: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  const server = await startSyncServer({ port: 0, secrets: [SECRET], lease: { leases, nodeId: "node-a" } });
  await dial(server.url, free).welcomed; // that room is open
  const waiting = dial(server.url, heldByTheDead);
  while (!asked.has(heldByTheDead)) await new Promise((resolve) => setTimeout(resolve, 10)); // waiting for its lease

  const started = performance.now();
  await server.close();
  expect(performance.now() - started).toBeLessThan(2000); // the lease it waits for lives 10 s
  expect(released).toEqual([free]);
  expect(await waiting.closed).toBe(4503); // "try again": its peer reconnects to another node
});
