import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { applyOp, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { connect, useSyncServer } from "./testing.ts";

const ctx = useSyncServer({ limits: { maxNodes: 6, maxDepth: 3 } });
const add = (nodeId: string, parentId = ROOT_ID, component = "Stack"): Op => ({ type: "add_node", nodeId, parentId, index: 99, component, props: component === "Button" ? { label: "Go" } : {} });

test("a joining peer is welcomed with the document and its sequence number", async () => {
  const peer = await connect(ctx.server.url, randomUUID());
  expect(await peer.next("welcome")).toEqual({ type: "welcome", doc: emptyDoc(), seq: 0 });
  peer.close();
});

test("ops from several peers get ONE order, every peer sees the same order, and a late joiner gets the result", async () => {
  const documentId = randomUUID();
  const [a, b] = await Promise.all([connect(ctx.server.url, documentId), connect(ctx.server.url, documentId)]);
  await Promise.all([a.next("welcome"), b.next("welcome")]);

  // Sent at the same moment from two sockets: only the room can say which came first.
  a.send(add("a1")); b.send(add("b1")); a.send(add("a2")); b.send(add("b2")); a.send(add("a3"));
  const seenByA = await Promise.all([1, 2, 3, 4, 5].map((seq) => a.next("op", (m) => m.seq === seq)));
  const seenByB = await Promise.all([1, 2, 3, 4, 5].map((seq) => b.next("op", (m) => m.seq === seq)));
  expect(seenByB).toEqual(seenByA); // same ops, same order, same actors
  expect(seenByA.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]); // contiguous, starting at 1

  const expected = seenByA.reduce<Doc>((doc, m) => applyOp(doc, m.op), emptyDoc());
  const late = await connect(ctx.server.url, documentId);
  expect(await late.next("welcome")).toEqual({ type: "welcome", doc: expected, seq: 5 });
  for (const peer of [a, b, late]) peer.close();
});

test("the room stamps the actor from the verified session; the sender gets its own op back as the acknowledgement", async () => {
  const documentId = randomUUID();
  const [a, b] = await Promise.all([connect(ctx.server.url, documentId), connect(ctx.server.url, documentId)]);
  const opId = a.send(add("n1"));
  const acked = await a.next("op", (m) => m.opId === opId);
  expect(acked.actor).toEqual({ kind: "user", id: a.userId });
  expect((await b.next("op", (m) => m.opId === opId)).actor).toEqual({ kind: "user", id: a.userId });
  for (const peer of [a, b]) peer.close();
});

test("a resent opId is answered with its ORIGINAL seq, is not applied twice, and nobody else hears about it", async () => {
  const documentId = randomUUID();
  const [a, b] = await Promise.all([connect(ctx.server.url, documentId), connect(ctx.server.url, documentId)]);
  const opId = a.send(add("once"));
  const first = await a.next("op", (m) => m.opId === opId);
  await b.next("op", (m) => m.opId === opId);

  a.send(add("once"), opId); // the retry a reconnecting client makes when it never saw the ack
  const again = await a.next("op", (m) => m.opId === opId);
  expect(again).toEqual(first); // same seq: NOT a duplicate_node error, NOT a new op

  const marker = b.send(add("marker"));
  const next = await b.next("op", (m) => m.seq > first.seq);
  expect(next.opId).toBe(marker); // b saw nothing between the original and the marker
  expect(next.seq).toBe(first.seq + 1); // and the retry did not consume a sequence number
  for (const peer of [a, b]) peer.close();
});

test("an invalid op is rejected with its reason, to the sender only, and changes nothing", async () => {
  const documentId = randomUUID();
  const [a, b] = await Promise.all([connect(ctx.server.url, documentId), connect(ctx.server.url, documentId)]);
  a.send(add("outer"));
  a.send(add("inner", "outer"));
  await b.next("op", (m) => m.seq === 2);

  const cyc = a.send({ type: "move_node", nodeId: "outer", newParentId: "inner", index: 0 });
  expect(await a.next("rejected")).toEqual({ type: "rejected", opId: cyc, reason: "cycle" });
  const unknown = a.send(add("x", ROOT_ID, "Carousel"));
  expect(await a.next("rejected")).toEqual({ type: "rejected", opId: unknown, reason: "unknown_component" });
  const gone = a.send({ type: "set_prop", nodeId: "never-existed", key: "gap", value: 1 });
  expect(await a.next("rejected")).toEqual({ type: "rejected", opId: gone, reason: "gone" });

  const marker = b.send(add("marker"));
  expect((await b.next("op", (m) => m.seq === 3)).opId).toBe(marker); // seq 3: the three rejects took no numbers
  expect(b.inbox.some((m) => m.type === "rejected")).toBe(false);
  for (const peer of [a, b]) peer.close();
});

test("a document cannot grow without bound: node count and depth are capped", async () => {
  const peer = await connect(ctx.server.url, randomUUID());
  for (const id of ["n1", "n2", "n3", "n4", "n5"]) peer.send(add(id)); // root + 5 = the cap of 6
  await peer.next("op", (m) => m.seq === 5);
  const tooMany = peer.send(add("n6"));
  expect(await peer.next("rejected")).toEqual({ type: "rejected", opId: tooMany, reason: "document_limit" });

  const deep = await connect(ctx.server.url, randomUUID());
  deep.send(add("d1")); deep.send(add("d2", "d1")); deep.send(add("d3", "d2")); // depth 3 = the cap: allowed
  await deep.next("op", (m) => m.seq === 3);
  const tooDeep = deep.send(add("d4", "d3")); // depth 4
  expect(await deep.next("rejected")).toEqual({ type: "rejected", opId: tooDeep, reason: "document_limit" });
  peer.close(); deep.close();
});

test("a frame that is not a valid message closes that peer (4400) and leaves the room working", async () => {
  const documentId = randomUUID();
  const [bad, good] = await Promise.all([connect(ctx.server.url, documentId), connect(ctx.server.url, documentId)]);
  bad.sendRaw({ type: "op", opId: randomUUID(), baseSeq: 0, op: add("x"), actor: { kind: "user", id: "someone-else" } }); // tries to choose its identity
  expect((await bad.closed).code).toBe(4400);
  const other = await connect(ctx.server.url, documentId);
  other.sendRaw("this is not json");
  expect((await other.closed).code).toBe(4400);

  const opId = good.send(add("still-works"));
  expect((await good.next("op", (m) => m.opId === opId)).seq).toBe(1);
  good.close();
});

test("without a valid token the WebSocket is never opened: the upgrade is answered with HTTP 401", async () => {
  const documentId = randomUUID();
  const { default: WebSocket } = await import("ws");
  for (const protocols of [[], ["noon.v1"], ["noon.v1", "not-a-token"]]) {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${ctx.server.url}/documents/${documentId}`, protocols);
      socket.on("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); });
      socket.on("open", () => { reject(new Error("the socket opened without a valid token")); });
      socket.on("error", () => undefined);
    });
    expect(status, JSON.stringify(protocols)).toBe(401);
  }
});
