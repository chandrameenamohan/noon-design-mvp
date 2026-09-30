import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import WebSocket from "ws";
import type { Op } from "@noon/contracts";
import { ROOT_ID } from "@noon/doc-model";
import { signSessionToken } from "@noon/session-token";
import { connect, TEST_ORG, TEST_SECRET, until, upgradeStatus, useSyncServer } from "./testing.ts";

const HEARTBEAT_MS = 150;
// This file floods on purpose (a stalled reader, a full backlog): the op budget of E2.9 is lifted so that it tests what it means to test.
const ctx = useSyncServer({ heartbeatMs: HEARTBEAT_MS, maxBufferedBytes: 1024 * 1024, rate: { perSecond: 1_000_000, burst: 1_000_000 } });
const add = (nodeId: string, props: Record<string, string> = {}): Op => ({ type: "add_node", nodeId, parentId: ROOT_ID, index: 99, component: "Text", props: { value: "x", ...props } });

test("every way a token can be wrong is an HTTP 401 at the upgrade, and no WebSocket is ever opened", async () => {
  const documentId = randomUUID();
  const userId = randomUUID();
  const sign = (over: Partial<Parameters<typeof signSessionToken>[0]> = {}) => signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60, ...over });
  const url = `${ctx.server.url}/documents/${documentId}`;
  const cases: [string, string, string[]][] = [
    ["no protocol at all", url, []],
    ["protocol but no token", url, ["noon.v1"]],
    ["garbage token", url, ["noon.v1", "not.a.token"]],
    ["signed with another secret", url, ["noon.v1", sign({ secret: "x".repeat(32) })]],
    ["expired", url, ["noon.v1", sign({ now: Math.floor(Date.now() / 1000) - 3600 })]],
    ["minted for another document", url, ["noon.v1", sign({ documentId: randomUUID() })]],
    ["wrong protocol name", url, ["noon.v2", sign()]],
    ["a path that names no document", `${ctx.server.url}/documents/not-a-uuid`, ["noon.v1", sign()]],
    ["an unknown path", `${ctx.server.url}/rooms/${documentId}`, ["noon.v1", sign()]],
  ];
  for (const [label, target, protocols] of cases) expect(await upgradeStatus(target, protocols), label).toBe(401);
  expect(ctx.server.peerCount(documentId)).toBe(0);
});

test("a token a few seconds past its expiry still opens: clocks on two machines never agree exactly", async () => {
  const documentId = randomUUID();
  const justExpired = signSessionToken({ userId: randomUUID(), orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60, now: Math.floor(Date.now() / 1000) - 63 });
  const socket = new WebSocket(`${ctx.server.url}/documents/${documentId}`, ["noon.v1", justExpired]);
  await new Promise<void>((resolve, reject) => { socket.once("open", () => { resolve(); }); socket.once("unexpected-response", () => { reject(new Error("refused within the leeway")); }); });
  socket.close();
});

test("a frozen peer (connected, but answering nothing) is dropped by the heartbeat; a healthy one stays", async () => {
  const documentId = randomUUID();
  const healthy = await connect(ctx.server.url, documentId);
  // autoPong: false = this client never answers a ping: what a suspended laptop or a dead NAT looks like.
  const frozen = await connect(ctx.server.url, documentId, randomUUID(), { autoPong: false });
  expect(ctx.server.peerCount(documentId)).toBe(2);

  const started = Date.now();
  const closed = await frozen.closed;
  const took = Date.now() - started;
  // Only a LOWER bound: it cannot be dropped before one full interval has passed unanswered. An upper
  // bound would only test how busy this machine is; that it IS dropped is proven by reaching this line.
  expect(took, `dropped after ${String(took)} ms`).toBeGreaterThanOrEqual(HEARTBEAT_MS);
  expect(closed.code).toBe(1006); // terminated, not politely closed: nobody was listening
  await until(() => ctx.server.peerCount(documentId) === 1, "the room to notice the dropped peer");

  const opId = healthy.send(add("still-here"));
  expect((await healthy.next("op", (m) => m.opId === opId)).seq).toBe(1);
  healthy.close();
});

test("a peer that stops reading is dropped once its backlog passes the limit, and nobody else is slowed", { timeout: 60_000 }, async () => {
  const documentId = randomUUID();
  const [writer, slow] = await Promise.all([connect(ctx.server.url, documentId), connect(ctx.server.url, documentId)]);
  await slow.next("welcome");
  slow.pauseReading(); // the socket stays open but nothing is read: the server's send buffer for it grows

  // The operating system buffers several megabytes between two local sockets before the server's
  // own queue (bufferedAmount) starts to grow, so it takes real volume to show the effect.
  const big = "y".repeat(9000);
  writer.send(add("n"));
  // Watch the SERVER's view: a client that reads nothing never learns it was dropped, so its own
  // "close" event would never fire.
  const slowIsGone = (): boolean => ctx.server.peerCount(documentId) === 1;
  // The writer sends in small batches and waits for each acknowledgement, so ITS backlog stays far
  // under the limit however slowly this test reads. Only the peer that reads nothing falls behind.
  let sent = 0;
  while (!slowIsGone() && sent < 6000) {
    let last = "";
    for (let i = 0; i < 20; i++, sent++) last = writer.send({ type: "set_prop", nodeId: "n", key: "value", value: `${big}${String(sent)}` });
    await writer.next("op", (m) => m.opId === last); // the writer is never held up by the stalled peer
  }
  expect(slowIsGone(), `the stalled peer survived ${String(sent)} broadcasts`).toBe(true);
  expect(sent).toBeLessThan(6000);
  writer.close();
});

test("an oversized frame closes that peer with 1009 and the server carries on", async () => {
  const documentId = randomUUID();
  const [rude, polite] = await Promise.all([connect(ctx.server.url, documentId), connect(ctx.server.url, documentId)]);
  rude.sendRaw({ type: "op", opId: randomUUID(), baseSeq: 0, op: add("huge", { value: "z".repeat(70_000) }) });
  expect((await rude.closed).code).toBe(1009); // "message too big", sent by the ws library

  const opId = polite.send(add("fine"));
  expect((await polite.next("op", (m) => m.opId === opId)).seq).toBe(1);
  polite.close();
});

// From the E3.2 review: the worker became the SECOND place that mints session tokens, so "one room = one org"
// no longer rests on a single signer. The room's org is whoever opened it; a token for another org is a stranger.
test("a token for the same document but ANOTHER org is refused like an unknown document", async () => {
  const documentId = randomUUID();
  const first = await connect(ctx.server.url, documentId);
  await first.next("welcome");
  const stranger = await connect(ctx.server.url, documentId, randomUUID(), {}, "33333333-3333-4333-8333-333333333333");
  expect((await stranger.closed).code).toBe(4404);
  expect(ctx.server.peerCount(documentId)).toBe(1);
  first.close();
});
