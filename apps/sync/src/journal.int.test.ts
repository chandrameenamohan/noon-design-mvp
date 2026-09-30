import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { applyOp, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { startSyncServer } from "./server.ts";
import { connect, TEST_SECRET, until } from "./testing.ts";

// E6.1a over real sockets and real Postgres: the journal is written before anyone hears of an op, and
// it answers a resend with the original seq after the room (and the whole process) went away.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const add = (nodeId: string, parentId = ROOT_ID): Op => ({ type: "add_node", nodeId, parentId, index: 99, component: "Stack", props: {} });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const start = () => startSyncServer({ port: 0, secrets: [TEST_SECRET], store: t.db.documentStore() });

async function aDocument(): Promise<{ id: string; orgId: string }> {
  const org = await t.createOrg("Journal");
  const ws = await t.db.forOrg(org.id).createWorkspace({ name: "ws" });
  const doc = await t.db.forOrg(org.id).createDocument({ workspaceId: ws.id, title: "Checkout" });
  if (!doc) throw new Error("no document");
  return { id: doc.id, orgId: org.id };
}

// integration:no-broadcast-on-append-failure
test("if the journal append fails, no peer receives the op, the sender is refused, and the document is untouched", async () => {
  const server = await start();
  try {
    const doc = await aDocument();
    const [a, b] = await Promise.all([connect(server.url, doc.id, randomUUID(), {}, doc.orgId), connect(server.url, doc.id, randomUUID(), {}, doc.orgId)]);
    await Promise.all([a.next("welcome"), b.next("welcome")]);
    // A rival writer took seq 1 behind the room's back (what F22's fencing is for): the append breaks op_journal_seq.
    await t.rawQuery(
      "insert into op_journal (document_id, org_id, seq, op_id, actor_kind, actor_id, op) values ($1, $2, 1, $3, 'user', 'rival', $4)",
      [doc.id, doc.orgId, randomUUID(), JSON.stringify(add("rival"))],
    );
    const opId = a.send(add("n1"));
    expect(await a.next("rejected", (m) => m.opId === opId)).toMatchObject({ reason: "unavailable" });
    await sleep(200); // b's socket is not a's: give a wrongly sent broadcast time to arrive
    expect([...a.inbox, ...b.inbox].filter((m) => m.type === "op")).toEqual([]);
    expect(await t.rawQuery("select actor_id from op_journal where document_id = $1", [doc.id])).toMatchObject({ rows: [{ actor_id: "rival" }] });

    // The database, not a bug, refused: the room did not apply the op, so what it saves has no n1.
    a.close(); b.close();
    await Promise.all([a.closed, b.closed]);
    await until(() => server.roomCount() === 0, "the room to be saved and dropped");
    await server.idle();
    const stored = (await t.rawQuery("select content, seq from documents where id = $1", [doc.id])) as { rows: [{ content: Doc | null; seq: string }] };
    expect(stored.rows[0].seq).toBe("0");
    expect(stored.rows[0].content?.nodes["n1"]).toBeUndefined();
  } finally {
    await server.close();
  }
});

// integration:journal-dedupe-after-restart
test("a resent op gets its original seq after a restart, even when the process died before saving the document", async () => {
  const doc = await aDocument();
  const userId = randomUUID();
  let server = await start();
  const a = await connect(server.url, doc.id, userId, {}, doc.orgId);
  await a.next("welcome");
  const ops = [add("outer"), add("inner", "outer"), { type: "set_prop", nodeId: "outer", key: "gap", value: 24 } satisfies Op];
  const opIds: string[] = [];
  for (const op of ops) {
    opIds.push(a.send(op));
    await a.next("op", (m) => m.opId === opIds.at(-1)); // one at a time, so each resend below has a known baseSeq
  }
  const expected = ops.reduce<Doc>(applyOp, emptyDoc());
  await server.close();
  await a.closed;
  // A crash: the save on last leave never happened. Only the journal knows about seq 1..3.
  await t.rawQuery("update documents set content = null, seq = 0 where id = $1", [doc.id]);

  server = await start();
  try {
    const back = await connect(server.url, doc.id, userId, {}, doc.orgId);
    // The room replayed the journal: nothing acknowledged is lost, and numbering continues from 3.
    expect(await back.next("welcome")).toMatchObject({ doc: expected, seq: 3 });
    // The ack of the set_prop never arrived. Resent as a real client would: with the baseSeq it had then.
    back.sendRaw({ type: "op", opId: opIds[2], baseSeq: 2, op: ops[2] });
    expect(await back.next("op", (m) => m.opId === opIds[2])).toMatchObject({ seq: 3, actor: { kind: "user", id: userId } });
    // A buggy or lying client resends the first op claiming to have seen everything: the unique key answers.
    back.sendRaw({ type: "op", opId: opIds[0], baseSeq: 3, op: ops[0] });
    expect(await back.next("op", (m) => m.opId === opIds[0])).toMatchObject({ seq: 1 });
    // And "inner" was removed... then re-added under the same id: refused, the journal remembers it.
    const removed = back.send({ type: "remove_node", nodeId: "inner" });
    expect((await back.next("op", (m) => m.opId === removed)).seq).toBe(4);
    const readd = back.send(add("inner", "outer"));
    expect(await back.next("rejected", (m) => m.opId === readd)).toMatchObject({ reason: "duplicate_node" });

    const fresh = back.send(add("after-restart"));
    expect((await back.next("op", (m) => m.opId === fresh)).seq).toBe(5);
    const journal = (await t.rawQuery("select seq, op_id from op_journal where document_id = $1 order by seq", [doc.id])) as { rows: { seq: string; op_id: string }[] };
    expect(journal.rows.map((r) => r.seq)).toEqual(["1", "2", "3", "4", "5"]); // no gap, and no op twice
    expect(new Set(journal.rows.map((r) => r.op_id)).size).toBe(5);
    back.close();
    await back.closed;
  } finally {
    await server.close();
  }
});
