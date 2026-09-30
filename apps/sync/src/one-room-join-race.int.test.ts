// integration:one-room-join-race (E7.1, F20). N peers of a brand-new document join at the same moment, split
// across both sync nodes before anyone owns the room: both nodes race for the lease, exactly one wins, and it
// issues exactly one fencing token; the loser sends its peers back to /session, and all N end in ONE room.
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ROOT_ID } from "@noon/doc-model";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { TEST_ORG, TEST_SECRET, until, useTwoNodes } from "./testing.ts";

const nodes = useTwoNodes();
const N = 10;
const ROUNDS = 5; // one lucky pass proves nothing about a race

test(`${String(N)} simultaneous joins split across both nodes: one owner, one token, one room, every edit everywhere`, async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const documentId = randomUUID();
    const peers = Array.from({ length: N }, (_, i) => {
      const userId = randomUUID();
      let first = true;
      return connectPeer({
        manifest,
        retryMs: { min: 20, max: 100 },
        session: async () => {
          // The first dial goes to the node this peer's half was given, owner or not: that is the race.
          // Every later one asks the router, as a real peer asks /session.
          const wsUrl = await nodes.route(documentId, first ? (i % 2 === 0 ? "node-a" : "node-b") : undefined);
          first = false;
          return { wsUrl, token: signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60 }) };
        },
      });
    });
    try {
      await until(() => peers.every((peer) => peer.status === "live"), `round ${String(round)}: all ${String(N)} peers live`, 10_000);
      const at = nodes.roomAt(documentId); // throws if both nodes hold a room
      expect(at).toBeGreaterThanOrEqual(0);
      expect(nodes.servers[at]?.peerCount(documentId)).toBe(N);
      expect(nodes.servers[1 - at]?.peerCount(documentId)).toBe(0);

      // Exactly one acquisition happened: the owner holds token 1 (a token is issued only with a SET, so a
      // second acquisition anywhere would own the room with 2). The lease names the room's node.
      expect(await nodes.owner(documentId)).toEqual({ token: 1, nodeId: at === 0 ? "node-a" : "node-b" });

      // One room means one order: every peer's edit reaches every peer, and all agree on the sequence.
      peers.forEach((peer, i) => { peer.submit({ type: "add_node", nodeId: `n-${String(i)}`, parentId: ROOT_ID, index: 0, component: "Text", props: { value: String(i) } }); });
      await until(() => peers.every((peer) => peer.pendingCount === 0 && peer.seq === N), `round ${String(round)}: every edit acknowledged and seen`, 10_000);
      const docs = new Set(peers.map((peer) => JSON.stringify(peer.confirmed)));
      expect(docs.size).toBe(1);
    } finally {
      for (const peer of peers) peer.close();
    }
    // The last peer gone, the owner snapshots and lets go; whoever takes the room next gets token 2, so the
    // counter had moved exactly once.
    await until(() => nodes.roomAt(documentId) === -1, `round ${String(round)}: the room closed`);
    await nodes.idle();
    expect(await nodes.owner(documentId)).toBeUndefined();
    expect((await nodes.leases.acquire(documentId, "probe")).holder.token).toBe(2);
  }
});
