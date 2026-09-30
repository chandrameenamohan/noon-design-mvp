import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import { applyOp, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { startSyncServer } from "./server.ts";
import { decodeSnapshot, encodeSnapshot, type SnapshotCadence, type SnapshotStore } from "./snapshots.ts";
import { connect, TEST_SECRET, testSnapshots, until } from "./testing.ts";

// E6.2 (F19) against the compose stack's Postgres and MinIO: rooms snapshot on their cadence, and opening
// loads the newest snapshot and replays ONLY the journal rows after it.
let t: TestDb;
let snapshots: SnapshotStore;
beforeAll(async () => {
  t = await createTestDb();
  snapshots = await testSnapshots();
});
afterAll(() => t.drop());

const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: ROOT_ID, index: 99, component: "Stack", props: {} });
const gap = (nodeId: string, value: number): Op => ({ type: "set_prop", nodeId, key: "gap", value });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const aDocument = () => t.createDocument("Snapshots");

/** The real store, with every `since` it answers written down: which seq it was asked from, how many rows it gave. */
function countingStore(): DocumentStore & { replays: { after: number; rows: number }[] } {
  const real = t.db.documentStore();
  const replays: { after: number; rows: number }[] = [];
  return {
    ...real,
    replays,
    since: async (orgId, documentId, seq) => {
      const rows = await real.since(orgId, documentId, seq);
      replays.push({ after: seq, rows: rows.length });
      return rows;
    },
  };
}
const start = (store: DocumentStore, cadence: Partial<SnapshotCadence> = {}) =>
  startSyncServer({ port: 0, secrets: [TEST_SECRET], store, snapshots, cadence: { everyOps: 1_000_000, everyMs: 3_600_000, ...cadence } });
const snapshotSeq = async (documentId: string): Promise<number> =>
  Number(((await t.rawQuery("select snapshot_seq from documents where id = $1", [documentId])) as { rows: [{ snapshot_seq: string }] }).rows[0].snapshot_seq);

async function snapshotReaches(documentId: string, seq: number, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while ((await snapshotSeq(documentId)) !== seq) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

/** Sends each op and waits for its acknowledgement: numbering is then known. */
async function edit(peer: Awaited<ReturnType<typeof connect>>, ops: Op[]): Promise<void> {
  for (const op of ops) {
    const opId = peer.send(op);
    await peer.next("op", (m) => m.opId === opId);
  }
}

// integration:snapshot-replay-only-later-rows
test("opening loads the newest snapshot and replays only the journal rows after it", async () => {
  const doc = await aDocument();
  const first = [add("a"), add("b"), gap("a", 1), gap("b", 2), add("c"), gap("c", 3), gap("a", 4)];
  let server = await start(countingStore());
  const peer = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
  await peer.next("welcome");
  await edit(peer, first);
  peer.close();
  await until(() => server.roomCount() === 0, "the last leave to snapshot and drop the room");
  await server.idle();
  await server.close();

  // Stored in MinIO under the zero-padded key, THEN named in Postgres.
  const at7 = first.reduce<Doc>(applyOp, emptyDoc());
  expect(await snapshotSeq(doc.id)).toBe(7);
  const bytes = await snapshots.get(doc.orgId, doc.id, 7);
  expect(bytes && decodeSnapshot(bytes)).toEqual(at7);
  // IfNoneMatch: a second writer of the same key changes nothing.
  await snapshots.put(doc.orgId, doc.id, 7, encodeSnapshot(emptyDoc()));
  const again = await snapshots.get(doc.orgId, doc.id, 7);
  expect(again && decodeSnapshot(again)).toEqual(at7);

  // Three more ops journaled after the snapshot, by a room that died before its next one.
  const later = [gap("b", 5), add("d"), gap("d", 6)];
  const journal = t.db.documentStore();
  for (const [i, op] of later.entries()) await journal.append(doc.orgId, doc.id, { seq: 8 + i, opId: randomUUID(), actor: { kind: "user", id: "crashed" }, op });

  const store = countingStore();
  server = await start(store);
  try {
    const back = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
    expect(await back.next("welcome")).toMatchObject({ seq: 10, doc: later.reduce<Doc>(applyOp, structuredClone(at7)) });
    expect(store.replays).toEqual([{ after: 7, rows: 3 }]); // the 7 rows under the snapshot were never read
    back.close();
  } finally {
    await server.close();
  }
});

test("a snapshot that is not a well-formed document is refused: the room does not open on top of it", async () => {
  const doc = await aDocument();
  const ghost = { rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null, children: ["ghost"] } } };
  await snapshots.put(doc.orgId, doc.id, 3, gzipSync(JSON.stringify(ghost)));
  await t.db.documentStore().snapshotted(doc.orgId, doc.id, 3);
  const server = await start(t.db.documentStore());
  try {
    const peer = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
    expect((await peer.closed).code).toBe(4500);
  } finally {
    await server.close();
  }
});

// integration:snapshot-cadence
test("a room snapshots every N ops, every T while peers are connected, and when the last peer leaves", async () => {
  const doc = await aDocument();
  // Every 5 ops (the timer is out of reach).
  let server = await start(t.db.documentStore(), { everyOps: 5 });
  const peer = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
  await peer.next("welcome");
  await edit(peer, [add("a"), gap("a", 1), gap("a", 2), gap("a", 3)]);
  await sleep(200);
  expect(await snapshotSeq(doc.id)).toBe(0);
  await edit(peer, [gap("a", 4)]);
  await snapshotReaches(doc.id, 5, "the 5th op to snapshot");
  await edit(peer, [gap("a", 5), gap("a", 6)]);
  await sleep(200);
  expect(await snapshotSeq(doc.id)).toBe(5); // 2 ops since: not yet
  // On last leave, whatever the count.
  peer.close();
  await until(() => server.roomCount() === 0, "the last leave to snapshot and drop the room");
  await server.idle();
  expect(await snapshotSeq(doc.id)).toBe(7);
  await server.close();

  // Every T while someone is connected: a session that is never idle and never reaches N still snapshots.
  server = await start(t.db.documentStore(), { everyMs: 200 });
  try {
    const busy = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
    expect((await busy.next("welcome")).seq).toBe(7);
    await edit(busy, [gap("a", 7), gap("a", 8)]);
    await snapshotReaches(doc.id, 9, "the timer to snapshot");
    expect(server.peerCount(doc.id)).toBe(1); // still connected: this was the timer, not a leave
    for (const seq of [5, 7, 9]) expect(await snapshots.get(doc.orgId, doc.id, seq)).toBeDefined();
    busy.close();
  } finally {
    await server.close();
  }
});

// integration:open-10k-under-2s (F19)
test("a document with 10,000 journaled ops and no snapshot opens in under 2 s; after its snapshot, with no replay at all", async () => {
  const doc = await aDocument();
  const nodes = Array.from({ length: 100 }, (_, i) => `n${String(i)}`);
  const ops: Op[] = [...nodes.map(add), ...Array.from({ length: 9900 }, (_, i) => gap(nodes[i % nodes.length] ?? "n0", i))];
  await t.rawQuery(
    `insert into op_journal (document_id, org_id, seq, op_id, actor_kind, actor_id, op)
     select $1, $2, r.seq, gen_random_uuid(), 'user', 'bulk', r.op from jsonb_to_recordset($3::jsonb) as r(seq bigint, op jsonb)`,
    [doc.id, doc.orgId, JSON.stringify(ops.map((op, i) => ({ seq: i + 1, op })))],
  );
  const expected = ops.reduce<Doc>(applyOp, emptyDoc());

  const store = countingStore();
  const server = await start(store);
  try {
    let began = performance.now();
    const cold = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
    const welcome = await cold.next("welcome");
    const coldMs = performance.now() - began;
    expect(welcome).toMatchObject({ seq: 10_000, doc: expected });
    expect(store.replays).toEqual([{ after: 0, rows: 10_000 }]);
    expect(coldMs, `opened in ${coldMs.toFixed(0)} ms`).toBeLessThan(2000);
    cold.close();
    await until(() => server.roomCount() === 0, "the last leave to snapshot and drop the room");
    await server.idle();
    expect(await snapshotSeq(doc.id)).toBe(10_000);

    began = performance.now();
    const warm = await connect(server.url, doc.id, randomUUID(), {}, doc.orgId);
    expect(await warm.next("welcome")).toMatchObject({ seq: 10_000, doc: expected });
    const warmMs = performance.now() - began;
    expect(store.replays.at(-1)).toEqual({ after: 10_000, rows: 0 });
    expect(warmMs, `opened in ${warmMs.toFixed(0)} ms`).toBeLessThan(2000);
    warm.close();
  } finally {
    await server.close();
  }
});
