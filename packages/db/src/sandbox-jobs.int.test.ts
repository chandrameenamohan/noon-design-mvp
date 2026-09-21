import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";

// E4.2b: the `sandbox` queue's jobs. One unfinished job per document is the RIGHT to start and keep
// that document's sandbox, so it is enforced where no code path can walk around it: an index.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

async function newDocument(): Promise<{ orgId: string; documentId: string }> {
  const org = await t.createOrg("Sandbox jobs");
  const ws = await t.db.forOrg(org.id).createWorkspace({ name: "ws" });
  const doc = await t.db.forOrg(org.id).createDocument({ workspaceId: ws.id, title: "doc" });
  if (!doc) throw new Error("unreachable");
  return { orgId: org.id, documentId: doc.id };
}
const insertJob = async ({ orgId, documentId }: { orgId: string; documentId: string }, queue = "sandbox", extra = ""): Promise<string> => {
  const res = (await t.rawQuery(`insert into jobs (org_id, document_id, queue, input${extra ? ", status, started_at" : ""}) values ($1, $2, $3, '{}'${extra}) returning id`, [orgId, documentId, queue])) as { rows: [{ id: string }] };
  return res.rows[0].id;
};

test("a document has at most one unfinished sandbox job, and it does not hold up the document's AI run", async () => {
  const doc = await newDocument();
  await insertJob(doc);
  await expect(insertJob(doc)).rejects.toMatchObject({ code: "23505" });
  await expect(insertJob(doc, "sandbox", ", 'running', now()")).rejects.toMatchObject({ code: "23505" });
  await insertJob(doc, "ai"); // the two queues do not block each other
});

test("sandbox jobs are swept and claimed like AI jobs, and the claimed job says which queue it is", async () => {
  const doc = await newDocument();
  const jobId = await insertJob(doc);
  expect(await t.db.jobStore().queued(1000)).toContainEqual({ queue: "sandbox", jobId, orgId: doc.orgId });
  expect(await t.db.jobStore().claim({ queue: "ai", jobId, orgId: doc.orgId })).toBeUndefined(); // the wrong queue claims nothing
  expect(await t.db.jobStore().claim({ queue: "sandbox", jobId, orgId: doc.orgId })).toMatchObject({ id: jobId, queue: "sandbox", documentId: doc.documentId });
});

test("a running sandbox job reports where its preview answers; a job that is not running cannot", async () => {
  const doc = await newDocument();
  const jobId = await insertJob(doc);
  const key = { queue: "sandbox" as const, jobId, orgId: doc.orgId };
  const output = async (): Promise<unknown> => ((await t.rawQuery("select output from jobs where id = $1", [jobId])) as { rows: [{ output: unknown }] }).rows[0].output;

  await t.db.jobStore().report(key, { url: "http://127.0.0.1:20001/noon-preview/" });
  expect(await output()).toBeNull(); // still queued
  await t.db.jobStore().claim(key);
  await t.db.jobStore().report(key, { url: "http://127.0.0.1:20001/noon-preview/" });
  expect(await output()).toEqual({ url: "http://127.0.0.1:20001/noon-preview/" });
  // Validated before the write, with the contract a reader will use.
  await expect(t.db.jobStore().report(key, { url: "javascript:alert(1)" })).rejects.toThrow();
  await expect(t.db.jobStore().report(key, { url: "not a url" })).rejects.toThrow();
  expect(await output()).toEqual({ url: "http://127.0.0.1:20001/noon-preview/" });
});

test("a document's sandbox is in use while its job is unfinished, and for a grace period after, and never because of another queue", async () => {
  const [waiting, running, justDone, longDone, aiOnly] = await Promise.all([newDocument(), newDocument(), newDocument(), newDocument(), newDocument()]);
  await insertJob(waiting);
  await insertJob(running, "sandbox", ", 'running', now()");
  for (const [doc, ago] of [[justDone, "1 second"], [longDone, "1 hour"]] as const) {
    const id = await insertJob(doc, "sandbox", ", 'running', now()");
    await t.rawQuery(`update jobs set status = 'succeeded', finished_at = now() - interval '${ago}' where id = $1`, [id]);
  }
  await insertJob(aiOnly, "ai");

  const inUse = await t.db.jobStore().sandboxesInUse(60_000);
  expect(inUse).toContain(waiting.documentId);
  expect(inUse).toContain(running.documentId);
  expect(inUse).toContain(justDone.documentId);
  expect(inUse).not.toContain(longDone.documentId);
  expect(inUse).not.toContain(aiOnly.documentId);
});
