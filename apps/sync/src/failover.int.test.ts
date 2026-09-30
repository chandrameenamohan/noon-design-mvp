// integration:failover (E7.2, F21). Two sync nodes, one Redis. The node that owns a room dies without a word
// (its Redis connection first, so it neither releases its lease nor beats again): its peers ask the router again,
// are sent to the live node, and that node takes the room as soon as the dead lease expires, never later than
// about one ttl after the kill. The data half of F21 (no acknowledged op lost or doubled) needs the journal:
// scripts/chaos/kill-owner-failover.ts, against the compose stack.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { manifest } from "@noon/design-system";
import { createLeases, syncRouter, type Leases } from "@noon/lease";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { TEST_REDIS_URL } from "../../../packages/queue/src/testing.ts";
import { startSyncServer, type RunningSyncServer } from "./server.ts";
import { connect, until, TEST_ORG, TEST_SECRET } from "./testing.ts";

const TTL = 600;
const prefix = `test-failover-${randomUUID()}:`;
const ids = ["node-a", "node-b"] as const;
let leases: Leases[] = [];
let servers: RunningSyncServer[] = [];
let lookup: Leases | undefined; // the router's own client, as the api has one
let killed = false;

beforeAll(async () => {
  leases = ids.map(() => createLeases({ redisUrl: TEST_REDIS_URL, ttlMs: TTL, prefix }));
  lookup = createLeases({ redisUrl: TEST_REDIS_URL, prefix });
  await Promise.all([...leases, lookup].map((each) => each.ready()));
  servers = await Promise.all(ids.map((nodeId, i) => startSyncServer({ port: 0, secrets: [TEST_SECRET], lease: { leases: leases[i] as Leases, nodeId } })));
});
afterAll(async () => {
  await Promise.all(servers.map((server, i) => (i === 0 && killed ? Promise.resolve() : server.close())));
  await Promise.all(leases.filter((_, i) => !(i === 0 && killed)).map((each) => each.close()));
  await lookup?.close();
});

const table = () => ({ kind: "many", nodes: new Map(ids.map((id, i) => [id, (servers[i] as RunningSyncServer).url])) }) as const;

/** A peer that asks the router before every connection, as a browser asks /session. Its first dial goes to node-a. */
function peer(documentId: string) {
  const userId = randomUUID();
  let first = true;
  const route = syncRouter({ nodes: table(), owner: (id) => (lookup as Leases).owner(id), alive: (nodeIds) => (lookup as Leases).alive(nodeIds), pick: (live) => (first ? "node-a" : live[0] ?? "") });
  return connectPeer({
    manifest,
    retryMs: { min: 20, max: 100 },
    session: async () => {
      const wsUrl = await route(documentId);
      first = false;
      return { wsUrl, token: signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60 }) };
    },
  });
}

test("a restarted node finds its own dead run's lease on a room: it waits that lease out and opens the room, no 4409", async () => {
  const documentId = randomUUID();
  // What the previous run of node-b left behind when it was killed mid-room: a lease under its id, its ttl.
  const held = await (leases[1] as Leases).acquire(documentId, "node-b");
  const started = performance.now();
  const joined = await connect((servers[1] as RunningSyncServer).url, documentId);
  await joined.next("welcome");
  expect(performance.now() - started).toBeLessThan(TTL + TTL / 10 + 300);
  expect(await (lookup as Leases).owner(documentId)).toEqual({ nodeId: "node-b", token: held.holder.token + 1 });
  joined.close();
});

test("killing the owner moves the room: its peers reach the live node through the router, within about one ttl", async () => {
  const documentId = randomUUID();
  const peers = [peer(documentId), peer(documentId)];
  await until(() => peers.every((each) => each.status === "live"), "both peers live on node-a", 5000);
  const before = await (lookup as Leases).owner(documentId);
  expect(before).toMatchObject({ nodeId: "node-a" });

  // kill: Redis first, so the lease is neither renewed nor released and the heartbeat stops; then the sockets.
  killed = true;
  await (leases[0] as Leases).close();
  const killedAt = performance.now();
  await (servers[0] as RunningSyncServer).close();

  await until(() => peers.every((each) => each.status === "live") && (servers[1] as RunningSyncServer).peerCount(documentId) === 2, "both peers live on node-b", 5000);
  expect(performance.now() - killedAt).toBeLessThan(TTL + TTL / 10 + 500);
  const after = await (lookup as Leases).owner(documentId);
  expect(after).toMatchObject({ nodeId: "node-b" });
  expect(after?.token).toBeGreaterThan(before?.token ?? Infinity);
  for (const each of peers) each.close();
});
