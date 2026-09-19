import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { applyOp, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { startSyncServer, type RunningSyncServer } from "./server.ts";
import { connect, TEST_SECRET, until } from "./testing.ts";

// F8: a document reopened after everyone left shows its last state. KNOWN LIMIT until the journal
// (F18): the save happens when the last peer leaves, so a crash loses the edits since the last save.
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

async function aDocument(): Promise<{ id: string; orgId: string }> {
  const org = await t.createOrg("Persistence");
  const ws = await t.db.forOrg(org.id).createWorkspace({ name: "ws" });
  const doc = await t.db.forOrg(org.id).createDocument({ workspaceId: ws.id, title: "Checkout" });
  if (!doc) throw new Error("no document");
  return { id: doc.id, orgId: org.id };
}

test("when the last peer leaves the document is saved, the room is dropped, and a reopen shows the last state", async () => {
  const doc = await aDocument();
  const [a, b] = await Promise.all([connect(server.url, doc.id, randomUUID(), {}, doc.orgId), connect(server.url, doc.id, randomUUID(), {}, doc.orgId)]);
  const ops = [add("outer"), add("inner", "outer"), { type: "set_prop", nodeId: "outer", key: "gap", value: 24 } satisfies Op];
  for (const op of ops) a.send(op);
  await b.next("op", (m) => m.seq === 3);
  const expected = ops.reduce<Doc>(applyOp, emptyDoc());

  a.close();
  await a.closed;
  expect(server.roomCount()).toBe(1); // one peer is still here: nothing is dropped yet
  b.close();
  await b.closed;
  // The client saw the close; the server sees it a moment later, saves, and only then drops the room.
  await until(() => server.roomCount() === 0, "the room to be saved and dropped");
  await server.idle();

  const stored = await t.rawQuery("select content, seq from documents where id = $1", [doc.id]);
  expect(stored).toMatchObject({ rows: [{ content: expected, seq: "3" }] }); // bigint arrives as a string

  const again = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
  expect(await again.next("welcome")).toEqual({ type: "welcome", doc: expected, seq: 3 });
  const opId = again.send(add("after-reopen"));
  expect((await again.next("op", (m) => m.opId === opId)).seq).toBe(4); // numbering continues, it does not restart
  again.close();
});

test("an op sent the instant the socket opens is never silently lost while the document is still loading", async () => {
  const doc = await aDocument();
  for (let round = 0; round < 15; round++) {
    const peer = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
    const opId = peer.send(add(`early-${String(round)}`)); // sent before "welcome", so it cannot know the room's seq
    // It must get AN ANSWER. On a fresh document that is the op itself. On one reloaded from storage
    // the room says "stale": it cannot know whether an op from a peer that has seen nothing was
    // already applied, so the client must resync. What may never happen is silence.
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
