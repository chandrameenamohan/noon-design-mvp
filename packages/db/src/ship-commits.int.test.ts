import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";

// noon-91u, integration:ship-retry-keeps-commit-record. A ship whose worker died is retried (E9.2a). Every commit any
// of its attempts made stays known as Ship's, so the git peer never diffs Ship's own push (which would undo a canvas
// edit that raced the ship, the E5.3b concern), and the retry that found nothing new to commit does not wipe the
// commit the canvas shows.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const PR = { number: 7, url: "http://gitea.test/noon/app/pulls/7" };

async function aShip() {
  const doc = await t.createDocument("Ship retry");
  const res = (await t.rawQuery("insert into jobs (org_id, document_id, queue, input) values ($1, $2, 'ship', '{}') returning id", [doc.orgId, doc.id])) as { rows: [{ id: string }] };
  return { queue: "ship" as const, jobId: res.rows[0].id, orgId: doc.orgId };
}
const output = async (jobId: string): Promise<unknown> => ((await t.rawQuery("select output from jobs where id = $1", [jobId])) as { rows: [{ output: unknown }] }).rows[0].output;
/** The worker holding the attempt died: its heartbeat is stale, and the sweep puts the ship back in the queue. */
async function dies(jobId: string): Promise<void> {
  await t.rawQuery("update jobs set heartbeat_at = now() - interval '1 hour' where id = $1", [jobId]);
  expect(await t.db.jobStore().requeueStale(1000, 3)).toMatchObject({ requeued: 1 });
}

test("ship-retry-keeps-commit-record: a retry that finds nothing new to commit keeps the first attempt's commit, and the git peer still knows it as Ship's", async () => {
  const jobs = t.db.jobStore();
  const git = t.db.gitStore();
  const key = await aShip();
  const first = await jobs.claim(key);
  await jobs.report({ ...key, attempt: first?.attempt }, { commit: C1, pr: null }); // recorded, then pushed; then the worker died
  await dies(key.jobId);

  const retry = await jobs.claim(key);
  expect(retry?.attempt).toBe(2);
  expect(await output(key.jobId)).toEqual({ commit: C1, pr: null }); // requeued with its output
  // The branch holds the page already (the first attempt's push landed): no commit, the pull request found.
  await jobs.report({ ...key, attempt: retry?.attempt }, { commit: null, pr: PR });
  expect(await output(key.jobId)).toEqual({ commit: C1, pr: PR });
  expect(await git.shippedCommit(C1)).toBe(true);
});

test("a retry that makes a commit of its own does not make the first attempt's commit anybody else's", async () => {
  const jobs = t.db.jobStore();
  const git = t.db.gitStore();
  const key = await aShip();
  const first = await jobs.claim(key);
  await jobs.report({ ...key, attempt: first?.attempt }, { commit: C2, pr: null });
  await dies(key.jobId);
  const retry = await jobs.claim(key);
  // The document changed meanwhile: the retry commits again, on top of the first attempt's push.
  await jobs.report({ ...key, attempt: retry?.attempt }, { commit: C3, pr: null });
  await jobs.report({ ...key, attempt: retry?.attempt }, { commit: C3, pr: PR });
  expect(await output(key.jobId)).toEqual({ commit: C3, pr: PR });
  expect([await git.shippedCommit(C2), await git.shippedCommit(C3)]).toEqual([true, true]);
  expect(await t.rawQuery("select commit_sha from ship_commits where job_id = $1 order by commit_sha", [key.jobId])).toMatchObject({ rows: [{ commit_sha: C2 }, { commit_sha: C3 }] });
});

test("a slow attempt's commit, reported after it was given up on, is still known as Ship's (its push may be on its way), though it shows nowhere", async () => {
  const jobs = t.db.jobStore();
  const key = await aShip();
  const slow = await jobs.claim(key);
  await dies(key.jobId);
  await jobs.claim(key); // attempt 2 holds it now
  const late = "4".repeat(40);
  await jobs.report({ ...key, attempt: slow?.attempt }, { commit: late, pr: null });
  expect(await t.db.gitStore().shippedCommit(late)).toBe(true);
  expect(await output(key.jobId)).toBeNull(); // the slow attempt's output lands nowhere
  expect(await t.db.gitStore().shippedCommit("5".repeat(40))).toBe(false);
});
