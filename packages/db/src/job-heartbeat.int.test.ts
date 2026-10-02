import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";

// E9.2a (F28): a running job beats; one whose beat went stale was left by a dead worker and gets another attempt.
// "Stale" is simulated by moving heartbeat_at into the past: what a kill -9 leaves, without waiting for it.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

type Queue = "ai" | "sandbox" | "ship";
async function aJob(queue: Queue = "ai", documentId?: string): Promise<{ queue: Queue; jobId: string; orgId: string; documentId: string }> {
  const doc = documentId === undefined ? await t.createDocument("Heartbeat") : { id: documentId, orgId: await orgOf(documentId) };
  const res = (await t.rawQuery("insert into jobs (org_id, document_id, queue, input) values ($1, $2, $3, '{}') returning id", [doc.orgId, doc.id, queue])) as { rows: [{ id: string }] };
  return { queue, jobId: res.rows[0].id, orgId: doc.orgId, documentId: doc.id };
}
const orgOf = async (documentId: string): Promise<string> => ((await t.rawQuery("select org_id from documents where id = $1", [documentId])) as { rows: [{ org_id: string }] }).rows[0].org_id;
const row = async (jobId: string) =>
  ((await t.rawQuery("select status, error, attempts, output, heartbeat_at, started_at, finished_at from jobs where id = $1", [jobId])) as { rows: [{ status: string; error: string | null; attempts: number; output: unknown; heartbeat_at: Date | null; started_at: Date | null; finished_at: Date | null }] }).rows[0];
/** What a worker killed mid-job leaves: its last beat, `seconds` ago. */
const silentFor = (jobId: string, seconds: number) => t.rawQuery("update jobs set heartbeat_at = now() - make_interval(secs => $2) where id = $1", [jobId, seconds]);

test("a claim is the job's next attempt and beats at once; a beat says running, cancel, or lost", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  const claimed = await jobs.claim(key);
  expect(claimed?.attempt).toBe(1);
  expect((await row(key.jobId)).heartbeat_at).not.toBeNull();
  await silentFor(key.jobId, 5);
  expect(await jobs.heartbeat({ ...key, attempt: 1 })).toBe("running");
  expect(Date.now() - ((await row(key.jobId)).heartbeat_at?.getTime() ?? 0)).toBeLessThan(2000); // the beat moved it to now
  expect(await jobs.heartbeat({ ...key, attempt: 2 })).toBe("lost"); // an attempt that is not the job's
  await t.rawQuery("update jobs set cancel_requested_at = now() where id = $1", [key.jobId]);
  expect(await jobs.heartbeat({ ...key, attempt: 1 })).toBe("cancel");
  await jobs.finish({ ...key, attempt: 1 }, "cancelled");
  expect(await jobs.heartbeat({ ...key, attempt: 1 })).toBe("lost"); // finished: nobody's any more
  expect(await jobs.heartbeat({ ...key, orgId: (await t.createOrg("other")).id, attempt: 1 })).toBe("lost"); // another org's key touches nothing
});

test("a job whose beat went stale goes back to the queue, is offered again, and its next claim is attempt 2", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  await jobs.claim(key);
  await silentFor(key.jobId, 3);
  expect(await jobs.requeueStale(10_000, 3)).toEqual({ requeued: 0, lost: 0 }); // 3 s is not stale under a 10 s rule
  await silentFor(key.jobId, 30);
  expect(await jobs.requeueStale(10_000, 3)).toMatchObject({ requeued: 1 });
  expect(await row(key.jobId)).toMatchObject({ status: "queued", attempts: 1, heartbeat_at: null, started_at: null, finished_at: null });
  expect(await jobs.queued(1000)).toContainEqual({ queue: "ai", jobId: key.jobId, orgId: key.orgId });
  expect((await jobs.claim(key))?.attempt).toBe(2);
});

test("the dead attempt's late writes land nowhere: its finish and its beat are fenced by the attempt", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  await jobs.claim(key);
  await silentFor(key.jobId, 60);
  await jobs.requeueStale(10_000, 3);
  await jobs.claim(key); // attempt 2, on another worker
  await jobs.finish({ ...key, attempt: 1 }, "failed", "worker_stopped"); // the first worker wakes up and reports
  expect(await jobs.heartbeat({ ...key, attempt: 1 })).toBe("lost");
  expect(await row(key.jobId)).toMatchObject({ status: "running", attempts: 2 });
  await jobs.finish({ ...key, attempt: 2 }, "succeeded");
  expect(await row(key.jobId)).toMatchObject({ status: "succeeded", error: null });
});

// noon-elo.2.4: usage is billed once per job, so the attempt that bills must be the one that holds it. Unfenced, a
// given-up attempt's partial spend landed first and the replacement's full spend hit `on conflict do nothing`.
test("the usage a given-up attempt reports lands nowhere, before or after the next claim; the attempt that holds the job is billed", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  const spent = (costUsd: number) => ({ model: "claude-test-1", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
  const billed = async () => ((await t.rawQuery("select cost_usd::float8 as cost from usage where job_id = $1", [key.jobId])) as { rows: { cost: number }[] }).rows.map((r) => r.cost);
  await jobs.claim(key);
  await silentFor(key.jobId, 60);
  await jobs.requeueStale(10_000, 3);
  await jobs.recordUsage({ ...key, attempt: 1 }, spent(0.1)); // given away, not yet claimed again: still attempts = 1
  await jobs.claim(key);
  await jobs.recordUsage({ ...key, attempt: 1 }, spent(0.2)); // attempt 2 holds it
  expect(await billed()).toEqual([]);
  await jobs.recordUsage({ ...key, attempt: 2 }, spent(0.5));
  await jobs.finish({ ...key, attempt: 2 }, "succeeded");
  expect(await billed()).toEqual([0.5]);
});

test("the last attempt of a job the sweep ended (worker_lost, or cancelled) still bills what it spent", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  await jobs.claim(key);
  await t.rawQuery("update jobs set cancel_requested_at = now() where id = $1", [key.jobId]);
  await silentFor(key.jobId, 60);
  await jobs.requeueStale(10_000, 3);
  await jobs.recordUsage({ ...key, attempt: 1 }, { model: "claude-test-1", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.3 });
  expect(((await t.rawQuery("select count(*)::int as n from usage where job_id = $1", [key.jobId])) as { rows: [{ n: number }] }).rows[0].n).toBe(1);
});

test("a job that kills its worker every time ends: after maxAttempts claims it fails as worker_lost", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect((await jobs.claim(key))?.attempt).toBe(attempt);
    await silentFor(key.jobId, 60);
    await jobs.requeueStale(10_000, 3);
  }
  expect(await row(key.jobId)).toMatchObject({ status: "failed", error: "worker_lost", attempts: 3 });
  expect((await row(key.jobId)).finished_at).not.toBeNull();
  // The document is free again: one unfinished run per document no longer holds it.
  await aJob("ai", key.documentId);
});

test("a stale job someone asked to cancel ends cancelled instead of running again (F10)", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  await jobs.claim(key);
  await t.rawQuery("update jobs set cancel_requested_at = now() where id = $1", [key.jobId]);
  await silentFor(key.jobId, 60);
  expect(await jobs.requeueStale(10_000, 3)).toEqual({ requeued: 0, lost: 1 });
  expect(await row(key.jobId)).toMatchObject({ status: "cancelled", error: null });
});

test("a stale sandbox job frees its preview: its dead address is forgotten, and the document's next claim runs it (E4.2b)", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob("sandbox");
  await jobs.claim(key);
  await jobs.report(key, { url: "http://127.0.0.1:20001/noon-preview/" });
  await silentFor(key.jobId, 60);
  await jobs.requeueStale(10_000, 3);
  expect(await row(key.jobId)).toMatchObject({ status: "queued", output: null });
  expect((await jobs.claim(key))?.attempt).toBe(2);
});

test("stale ships of one document: the newest waits again with its commit kept; one with a ship already waiting fails", async () => {
  const jobs = t.db.jobStore();
  const older = await aJob("ship");
  await jobs.claim(older);
  const newer = await aJob("ship", older.documentId);
  await jobs.claim(newer);
  await jobs.report(newer, { commit: "c".repeat(40), pr: null });
  await silentFor(older.jobId, 60);
  await silentFor(newer.jobId, 60);
  expect(await jobs.requeueStale(10_000, 3)).toEqual({ requeued: 1, lost: 1 }); // two queued ships would break 0011
  expect(await row(newer.jobId)).toMatchObject({ status: "queued", output: { commit: "c".repeat(40), pr: null } }); // the git peer still knows Ship's push
  expect(await row(older.jobId)).toMatchObject({ status: "failed", error: "worker_lost" });

  const third = await aJob("ship");
  await jobs.claim(third);
  await aJob("ship", third.documentId); // a press after it started: waiting
  await silentFor(third.jobId, 60);
  await jobs.requeueStale(10_000, 3);
  expect(await row(third.jobId)).toMatchObject({ status: "failed", error: "worker_lost" }); // the waiting ship ships everything
});

test("a row left running from before heartbeats existed is judged by its start", async () => {
  const jobs = t.db.jobStore();
  const key = await aJob();
  await t.rawQuery("update jobs set status = 'running', started_at = now() - interval '1 hour', heartbeat_at = null where id = $1", [key.jobId]);
  expect(await jobs.requeueStale(10_000, 3)).toMatchObject({ requeued: 1 });
});

test("two sweeps at once never both take a row", async () => {
  const jobs = t.db.jobStore();
  const keys = await Promise.all(Array.from({ length: 10 }, () => aJob()));
  for (const key of keys) {
    await jobs.claim(key);
    await silentFor(key.jobId, 60);
  }
  const results = await Promise.all(Array.from({ length: 4 }, () => jobs.requeueStale(10_000, 3)));
  expect(results.reduce((n, r) => n + r.requeued, 0)).toBe(10); // every row once: the rows of the tests above are all queued or finished by now
  for (const key of keys) expect(await row(key.jobId)).toMatchObject({ status: "queued", attempts: 1 });
});
