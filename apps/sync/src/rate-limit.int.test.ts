import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { connect, TEST_ORG, TEST_SECRET, until, useSyncServer } from "./testing.ts";

// A small budget, so that a test reaches it in milliseconds: 50 ops at once, then 200 a second.
const ctx = useSyncServer({ rate: { perSecond: 200, burst: 50, maxStrikes: 100 } });
const add = (nodeId: string, parentId = ROOT_ID): Op => ({ type: "add_node", nodeId, parentId, index: 0, component: "Stack", props: {} });

test("a flooding peer is told to slow down, then dropped with 4429; the document holds only what fitted the budget", async () => {
  const documentId = randomUUID();
  const flooder = await connect(ctx.server.url, documentId);
  const witness = await connect(ctx.server.url, documentId);
  await flooder.next("welcome");
  for (let i = 0; i < 400; i++) flooder.send(add(`flood-${String(i)}`)); // ignores every "rate_limited"
  expect((await flooder.closed).code).toBe(4429);
  expect(flooder.inbox.some((m) => m.type === "rejected" && m.reason === "rate_limited" && (m.retryAfterMs ?? 0) > 0)).toBe(true);

  // The room is still fine for everyone else, and the flood did not get in.
  const opId = witness.send(add("after"));
  const accepted = await witness.next("op", (m) => m.opId === opId);
  expect(accepted.seq).toBeLessThan(80); // about the burst, not 400
  witness.close();
});

test("an HONEST client that makes 300 edits at once lands every one, in order, and is never dropped", async () => {
  const documentId = randomUUID();
  const userId = randomUUID();
  const statuses: string[] = [];
  const peer = connectPeer({
    manifest,
    onStatus: (status) => statuses.push(status),
    session: () => Promise.resolve({ wsUrl: `${ctx.server.url}/documents/${documentId}`, token: signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60 }) }),
  });
  await until(() => peer.status === "live", "live");

  // Chains of 60 (the depth cap is 64): each node is the child of the one before it, so ANY loss or
  // reordering on the way shows up as missing nodes.
  for (let i = 0; i < 300; i++) expect(peer.submit(add(`n${String(i)}`, i % 60 === 0 ? ROOT_ID : `n${String(i - 1)}`)).ok).toBe(true);
  await until(() => peer.pendingCount === 0, "all 300 acknowledged", 15_000); // 50 at once, then 200 a second

  const observer = await connect(ctx.server.url, documentId);
  const { doc, seq } = await observer.next("welcome");
  expect(Object.keys(doc.nodes)).toHaveLength(301);
  expect(seq).toBe(300); // each applied exactly once
  expect(statuses).toEqual(["connecting", "live"]); // slowed down by the budget, never disconnected
  peer.close();
  observer.close();
});
