import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Op, SequencedOp } from "@noon/contracts";
import { createTestDb, type TestDb } from "./testing.ts";

// E6.1a: the op journal's two unique keys, told apart by constraint name, and its org scoping.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 0, component: "Stack", props: {} });
const row = (seq: number, op: Op, actorId = "u1"): SequencedOp => ({ seq, opId: randomUUID(), actor: { kind: "agent", id: actorId, runId: "run-1" }, op });

async function aDocument(): Promise<{ id: string; orgId: string }> {
  const org = await t.createOrg("Journal");
  const ws = await t.db.forOrg(org.id).createWorkspace({ name: "ws" });
  const doc = await t.db.forOrg(org.id).createDocument({ workspaceId: ws.id, title: "Checkout" });
  if (!doc) throw new Error("no document");
  return { id: doc.id, orgId: org.id };
}

test("a sender's opId again is answered with the ORIGINAL row; a taken seq is refused by name", async () => {
  const store = t.db.documentStore();
  const doc = await aDocument();
  const first = row(1, add("n1"));
  expect(await store.append(doc.orgId, doc.id, first)).toBeUndefined();
  // The same sender and opId under a new number: a resend. Nothing is written, the original comes back.
  expect(await store.append(doc.orgId, doc.id, { ...first, seq: 2 })).toEqual(first);
  // Another sender may use the same opId: every broadcast shows it to everyone, so it is not a resend.
  expect(await store.append(doc.orgId, doc.id, { ...row(2, add("n2"), "u2"), opId: first.opId })).toBeUndefined();
  // A taken number is a rival writer, not a resend.
  await expect(store.append(doc.orgId, doc.id, row(2, add("n3")))).rejects.toMatchObject({ code: "23505", constraint: "op_journal_seq" });
  expect(await store.since(doc.orgId, doc.id, 0)).toEqual([first, expect.objectContaining({ seq: 2, actor: { kind: "agent", id: "u2", runId: "run-1" } })]);
  expect(await store.find(doc.orgId, doc.id, "u1", first.opId)).toEqual(first);
  expect(await store.find(doc.orgId, doc.id, "u3", first.opId)).toBeUndefined();
});

test("the journal is org-scoped: another org's document takes no op and shows none", async () => {
  const store = t.db.documentStore();
  const doc = await aDocument();
  const stranger = await aDocument();
  await expect(store.append(stranger.orgId, doc.id, row(1, add("n1")))).rejects.toThrow("gone");
  expect(await store.append(doc.orgId, doc.id, row(1, add("n1")))).toBeUndefined();
  expect(await store.since(stranger.orgId, doc.id, 0)).toEqual([]);
  expect(await store.everAdded(stranger.orgId, doc.id, "n1")).toBe(false);
  expect(await store.everAdded(doc.orgId, doc.id, "n1")).toBe(true);
  expect(await store.everAdded(doc.orgId, doc.id, "n2")).toBe(false);
});

test("since gives only the rows after a seq, in order, with seq as a number", async () => {
  const store = t.db.documentStore();
  const doc = await aDocument();
  for (let seq = 1; seq <= 5; seq++) await store.append(doc.orgId, doc.id, row(seq, add(`n${String(seq)}`)));
  expect((await store.since(doc.orgId, doc.id, 3)).map((r) => r.seq)).toEqual([4, 5]);
});
