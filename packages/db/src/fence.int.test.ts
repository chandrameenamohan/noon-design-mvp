import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { SequencedOp } from "@noon/contracts";
import { Fenced } from "./index.ts";
import { addNode as add, createTestDb, TEST_DATABASE_URL, type TestDb } from "./testing.ts";

// integration:append-stale-token-rejected (E7.3, F22). Two owners of one document: A (lease token 1) is the
// zombie, B (token 2) took the room after A's lease ran out. B claims the document, reads the journal, and numbers
// on from there. Whatever A tries after B's claim must be refused, in a REAL race, and the journal must end with no
// gap and no duplicate seq. The naive control (read the claim in app code, then insert) is shown to let A's row in.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const row = (seq: number, actorId: string): SequencedOp => ({ seq, opId: randomUUID(), actor: { kind: "user", id: actorId }, op: add(`${actorId}-${String(seq)}`) });
const seqs = async (documentId: string): Promise<{ seq: number; actor: string }[]> =>
  ((await t.rawQuery("select seq::int as seq, actor_id as actor from op_journal where document_id = $1 order by seq", [documentId])) as { rows: { seq: number; actor: string }[] }).rows;

test("claims only move forward, and a document's fence is what the next lease token must beat", async () => {
  const store = t.db.documentStore();
  const doc = await t.createDocument("Fence");
  expect(await store.fence(doc.orgId, doc.id)).toBe(0);
  expect(await store.claim(doc.orgId, doc.id, 3, randomUUID())).toBe(true);
  expect(await store.claim(doc.orgId, doc.id, 3, randomUUID())).toBe(false); // the same token again (a flushed Redis): refused
  expect(await store.claim(doc.orgId, doc.id, 2, randomUUID())).toBe(false);
  expect(await store.fence(doc.orgId, doc.id)).toBe(3);
  const stranger = await t.createDocument("Other");
  expect(await store.fence(stranger.orgId, doc.id)).toBeUndefined(); // another org's document does not exist
  expect(await store.claim(stranger.orgId, doc.id, 9, randomUUID())).toBe(false);
  expect(await store.fence(doc.orgId, doc.id)).toBe(3);
});

test("an append with a claim that is no longer the document's is refused as Fenced; an unclaimed append only lands on a never-claimed document", async () => {
  const store = t.db.documentStore();
  const doc = await t.createDocument("Fence");
  expect(await store.append(doc.orgId, doc.id, row(1, "solo"))).toBeUndefined(); // one node, no leases
  const a = randomUUID();
  await store.claim(doc.orgId, doc.id, 1, a);
  await expect(store.append(doc.orgId, doc.id, row(2, "solo"))).rejects.toBeInstanceOf(Fenced);
  expect(await store.append(doc.orgId, doc.id, row(2, "a"), a)).toBeUndefined();
  await store.claim(doc.orgId, doc.id, 2, randomUUID());
  await expect(store.append(doc.orgId, doc.id, row(3, "a"), a)).rejects.toBeInstanceOf(Fenced);
  expect(await seqs(doc.id)).toEqual([{ seq: 1, actor: "solo" }, { seq: 2, actor: "a" }]);
});

test("an append racing an uncommitted claim waits for it, then is refused: the check and the insert are one statement", async () => {
  const store = t.db.documentStore();
  const doc = await t.createDocument("Fence");
  const a = randomUUID();
  await store.claim(doc.orgId, doc.id, 1, a);
  const b = new Client({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${t.schema}` });
  await b.connect();
  try {
    await b.query("begin");
    await b.query("update documents set fence_token = 2, fence_claim = $2 where id = $1", [doc.id, randomUUID()]);
    // A read its claim BEFORE B's update committed: a read-then-write would insert now. The fenced append waits.
    let settled = false;
    const late = store.append(doc.orgId, doc.id, row(1, "a"), a).finally(() => { settled = true; });
    late.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    await b.query("commit");
    await expect(late).rejects.toBeInstanceOf(Fenced);
  } finally {
    await b.end();
  }
  expect(await seqs(doc.id)).toEqual([]);
});

/** The zombie: numbers on from its own memory, one append at a time, until the journal refuses it. */
async function zombie(store: ReturnType<TestDb["db"]["documentStore"]>, doc: { id: string; orgId: string }, claim: string) {
  const refusals: unknown[] = [];
  for (let seq = 1; seq <= 60; seq++) {
    try {
      await store.append(doc.orgId, doc.id, row(seq, "a"), claim);
    } catch (err) {
      refusals.push(err);
      if (err instanceof Fenced) break;
    }
  }
  return refusals;
}

/** The new owner: claims, reads the journal, numbers on from what it read. Returns the last seq it read. */
async function takeOver(store: ReturnType<TestDb["db"]["documentStore"]>, doc: { id: string; orgId: string }, afterMs: number): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, afterMs));
  const b = randomUUID();
  expect(await store.claim(doc.orgId, doc.id, 2, b)).toBe(true);
  const read = (await store.since(doc.orgId, doc.id, 0)).at(-1)?.seq ?? 0;
  for (let seq = read + 1; seq <= read + 20; seq++) await store.append(doc.orgId, doc.id, row(seq, "b"), b);
  return read;
}

test("real race, 20 rounds: after the claim no zombie append lands, and the journal has no gap and no duplicate seq", async () => {
  const store = t.db.documentStore();
  for (let round = 0; round < 20; round++) {
    const doc = await t.createDocument(`Race ${String(round)}`);
    const a = randomUUID();
    await store.claim(doc.orgId, doc.id, 1, a);
    const [refusals, read] = await Promise.all([zombie(store, doc, a), takeOver(store, doc, round % 5)]);
    const journal = await seqs(doc.id);
    expect(journal.map((r) => r.seq)).toEqual(journal.map((_, i) => i + 1)); // 1..n: no gap, no duplicate
    expect(journal.filter((r) => r.actor === "a").every((r) => r.seq <= read)).toBe(true); // A only before B read
    expect(journal.filter((r) => r.actor === "b")).toHaveLength(20);
    expect(refusals.at(-1)).toBeInstanceOf(Fenced); // the zombie was stopped by the fence, not by running out
  }
});

test("naive control: the claim read in app code, then an insert, lets the zombie's row in after the new owner read the journal", async () => {
  const store = t.db.documentStore();
  const doc = await t.createDocument("Naive");
  const a = randomUUID();
  await store.claim(doc.orgId, doc.id, 1, a);
  // Read-then-write, with the new owner's takeover landing between the read and the write: the one interleaving
  // a real pause produces (A reads, is frozen past its lease, B claims and reads, A resumes and writes).
  const current = ((await t.rawQuery("select fence_claim from documents where id = $1", [doc.id])) as { rows: [{ fence_claim: string }] }).rows[0].fence_claim;
  expect(current).toBe(a); // A believes it may write
  expect(await store.claim(doc.orgId, doc.id, 2, randomUUID())).toBe(true);
  const read = (await store.since(doc.orgId, doc.id, 0)).at(-1)?.seq ?? 0;
  const late = row(read + 1, "a");
  await t.rawQuery("insert into op_journal (document_id, org_id, seq, op_id, actor_kind, actor_id, op) values ($1, $2, $3, $4, 'user', 'a', $5)", [doc.id, doc.orgId, late.seq, late.opId, JSON.stringify(late.op)]);
  // The property the fenced append keeps is broken: a zombie row past what the new owner read. B's own next op
  // now collides on that seq, or (had B numbered first) A's op is lost from B's room and every peer's view.
  expect((await seqs(doc.id)).filter((r) => r.actor === "a" && r.seq > read)).toHaveLength(1);
  // The same interleaving through the fenced append: refused.
  await expect(store.append(doc.orgId, doc.id, row(read + 1, "a"), a)).rejects.toBeInstanceOf(Fenced);
});
