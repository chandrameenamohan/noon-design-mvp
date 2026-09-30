// integration:one-room-globally (E7.1, F20). Two sync nodes, one Redis. Every peer of a document lands in the
// same room, whichever node it asked first; two documents may live on different nodes; a node that is not the
// owner never opens a second room; and a node that loses its lease sends its peers to the new owner.
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ROOT_ID } from "@noon/doc-model";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { connect, until, TEST_ORG, TEST_SECRET, useTwoNodes } from "./testing.ts";

const TTL = 600;
const nodes = useTwoNodes({ ttlMs: TTL });
type Node = "node-a" | "node-b";

/** A peer that asks the router before every connection, as a browser asks /session. `firstTo` forces its first dial. */
function peer(documentId: string, firstTo?: Node) {
  const userId = randomUUID();
  let first = true;
  return connectPeer({
    manifest,
    retryMs: { min: 20, max: 100 },
    session: async () => {
      const wsUrl = await nodes.route(documentId, first ? firstTo : undefined);
      first = false;
      return { wsUrl, token: signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60 }) };
    },
  });
}
const add = (nodeId: string) => ({ type: "add_node", nodeId, parentId: ROOT_ID, index: 0, component: "Text", props: { value: nodeId } }) as const;

test("peers that first dial different nodes all end in the owner's room, and see each other's edits", async () => {
  const documentId = randomUUID();
  const first = peer(documentId, "node-a");
  await until(() => first.status === "live", "the first peer live", 5000);
  expect(await nodes.owner(documentId)).toMatchObject({ nodeId: "node-a" });
  // These dial the OTHER node first: it is not the owner, so it closes them with 4409 and they ask again.
  const late = [peer(documentId, "node-b"), peer(documentId, "node-b"), peer(documentId)];
  const all = [first, ...late];
  await until(() => all.every((each) => each.status === "live"), "every peer live", 5000);
  expect(nodes.roomAt(documentId)).toBe(0);
  expect(nodes.servers[0].peerCount(documentId)).toBe(4);
  all.forEach((each, i) => { each.submit(add(`n-${String(i)}`)); });
  await until(() => all.every((each) => each.pendingCount === 0 && each.seq === 4), "every edit seen by every peer", 5000);
  expect(new Set(all.map((each) => JSON.stringify(each.confirmed))).size).toBe(1);
  for (const each of all) each.close();
});

test("two documents may live on different nodes; a node that does not own a room refuses it with 4409", async () => {
  const onA = randomUUID();
  const onB = randomUUID();
  const a = await connect(nodes.servers[0].url, onA);
  const b = await connect(nodes.servers[1].url, onB);
  await a.next("welcome");
  await b.next("welcome");
  expect(await nodes.owner(onA)).toMatchObject({ nodeId: "node-a" });
  expect(await nodes.owner(onB)).toMatchObject({ nodeId: "node-b" });
  expect(nodes.roomAt(onA)).toBe(0);
  expect(nodes.roomAt(onB)).toBe(1);

  // Dialling the wrong node directly (a stale address, a forged one): no second room, just "ask again".
  const astray = await connect(nodes.servers[1].url, onA);
  expect(await astray.closed).toMatchObject({ code: 4409 });
  expect(nodes.servers[1].peerCount(onA)).toBe(0);
  expect(nodes.servers[1].roomCount()).toBe(1); // only onB
  a.close();
  b.close();
});

test("the last peer leaving lets the lease go, so the next join may land on either node", async () => {
  const documentId = randomUUID();
  const only = await connect(nodes.servers[1].url, documentId);
  await only.next("welcome");
  expect(await nodes.owner(documentId)).toMatchObject({ nodeId: "node-b" });
  only.close();
  await until(() => nodes.roomAt(documentId) === -1, "the room closed");
  await nodes.idle();
  expect(await nodes.owner(documentId)).toBeUndefined();
  const next = await connect(nodes.servers[0].url, documentId);
  await next.next("welcome");
  expect(await nodes.owner(documentId)).toMatchObject({ nodeId: "node-a", token: 2 });
  next.close();
});

test("a node whose lease is taken sends its peers away with 4409, and they land in the new owner's room", async () => {
  const documentId = randomUUID();
  const peers = [peer(documentId, "node-a"), peer(documentId, "node-a")];
  await until(() => peers.every((each) => each.status === "live"), "both peers live on node-a", 5000);
  expect(nodes.roomAt(documentId)).toBe(0);
  const before = await nodes.owner(documentId);

  // What a long pause of node-a looks like from outside: its lease is gone, and node-b takes the room.
  await nodes.leases.release(documentId, before ?? { token: 0, nodeId: "none" });
  const usurper = await connect(nodes.servers[1].url, documentId);
  await usurper.next("welcome");
  const after = await nodes.owner(documentId);
  expect(after).toMatchObject({ nodeId: "node-b" });
  expect(after?.token).toBeGreaterThan(before?.token ?? Infinity); // a later owner always carries a larger token

  // node-a's next renewal (every ttl/3) is refused: it gives its peers up; they ask again and join node-b.
  await until(() => nodes.servers[0].peerCount(documentId) === 0 && nodes.servers[1].peerCount(documentId) === 3, "every peer on node-b", 5000);
  await until(() => peers.every((each) => each.status === "live"), "both peers live again", 5000);
  expect(nodes.roomAt(documentId)).toBe(1);
  for (const each of peers) each.close();
  usurper.close();
});
