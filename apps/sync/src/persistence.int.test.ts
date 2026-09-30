import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Op } from "@noon/contracts";
import { ROOT_ID } from "@noon/doc-model";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { startSyncServer, type RunningSyncServer } from "./server.ts";
import { connect, TEST_SECRET, until } from "./testing.ts";

// Opening a document over real sockets and Postgres. F8's idle save (and its check, reopen-keeps-state) is
// gone since E6.2: a reopen is snapshot + journal replay, proven in snapshot.int.test.ts.
let t: TestDb;
let server: RunningSyncServer;
beforeAll(async () => {
  t = await createTestDb();
  server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store: t.db.documentStore() });
});
afterAll(async () => {
  await server.close();
  await t.drop();
});

const add = (nodeId: string, parentId = ROOT_ID): Op => ({ type: "add_node", nodeId, parentId, index: 99, component: "Stack", props: {} });

const aDocument = () => t.createDocument("Persistence");

test("an op sent the instant the socket opens is never silently lost while the document is still loading", async () => {
  const doc = await aDocument();
  for (let round = 0; round < 15; round++) {
    const peer = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
    const opId = peer.send(add(`early-${String(round)}`)); // sent before "welcome", so it cannot know the room's seq
    // It must get AN ANSWER: the op itself, since E6.1a even on a reloaded document (the journal says it
    // was never applied), or "stale" from a room without a journal. What may never happen is silence.
    const answer = await Promise.race([peer.next("op", (m) => m.opId === opId), peer.next("rejected", (m) => m.opId === opId)]);
    expect(answer.type === "op" || answer.reason === "stale", JSON.stringify(answer)).toBe(true);
    if (answer.type === "rejected") {
      const retry = peer.send(add(`early-${String(round)}`)); // now that it has been welcomed, the same edit goes through
      expect((await peer.next("op", (m) => m.opId === retry)).seq).toBeGreaterThan(0);
    }
    peer.close();
    await peer.closed;
    await until(() => server.roomCount() === 0, "the room to be dropped", 5000); // so the next round loads again
  }
});

test("a stored document that is not a well-formed tree is refused: the room does not open on top of corruption", async () => {
  const doc = await aDocument();
  const broken = { rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null, children: ["ghost"] } } };
  await t.rawQuery("update documents set content = $1, seq = 7 where id = $2", [JSON.stringify(broken), doc.id]);
  const peer = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
  expect((await peer.closed).code).toBe(4500);
  await until(() => server.roomCount() === 0, "the failed room to be forgotten");
});

test("a token for a document that does not exist in that org opens nothing", async () => {
  const peer = await connect(server.url, randomUUID(), randomUUID(), {}, randomUUID());
  expect((await peer.closed).code).toBe(4404);
});
