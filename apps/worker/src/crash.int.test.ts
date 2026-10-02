import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { Queue, Worker } from "bullmq";
import { connection, createProducer, type Producer } from "@noon/queue";
import { TEST_REDIS_URL } from "../../../packages/queue/src/testing.ts";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { startWorker, type Handlers, type RunningWorker } from "./worker.ts";

// E9.2a (F28), the worker's half: a job a dead worker left `running` is given another attempt once its heartbeat is
// stale, and a worker that was only SLOW, and was given up on, stops without writing over the attempt after it.
// The end-to-end version (a real `kill -9` of a worker container mid-run) is scripts/chaos/kill-worker-resumes.ts.
// E9.2b (§4 "Redis lost"): the queue's keys vanish under a working worker, and every job still runs exactly once
// (end to end, with the sync nodes' leases too: scripts/chaos/redis-wipe-rebuild.ts).
const prefix = `test-${randomBytes(6).toString("hex")}`;
let db: TestDb, producer: Producer;
let running: RunningWorker[] = [];
beforeAll(async () => {
  db = await createTestDb();
  producer = createProducer({ redisUrl: TEST_REDIS_URL, prefix });
});
afterEach(async () => {
  await Promise.all(running.map((w) => w.close())); // one test's worker must not drain the next test's jobs
  running = [];
});
afterAll(async () => {
  await producer.close();
  await db.drop();
});
const work = async (ai: NonNullable<Handlers["ai"]>, staleMs: number, concurrency?: number): Promise<RunningWorker> => {
  const worker = await startWorker({ db: db.db, redisUrl: TEST_REDIS_URL, prefix, handlers: { ai }, sweepMs: 100, cancelPollMs: 100, staleMs, ...(concurrency === undefined ? {} : { concurrency: { ai: concurrency } }) });
  running.push(worker);
  return worker;
};
async function aJob(): Promise<{ queue: "ai"; jobId: string; orgId: string }> {
  const doc = await db.createDocument("Crash");
  const res = (await db.rawQuery("insert into jobs (org_id, document_id, queue, input) values ($1, $2, 'ai', '{}') returning id", [doc.orgId, doc.id])) as { rows: [{ id: string }] };
  return { queue: "ai", jobId: res.rows[0].id, orgId: doc.orgId };
}
const row = async (jobId: string) => ((await db.rawQuery("select status, error, attempts from jobs where id = $1", [jobId])) as { rows: [{ status: string; error: string | null; attempts: number }] }).rows[0];
async function until(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a job left running by a dead worker runs again once its heartbeat is stale, and succeeds as attempt 2", async () => {
  const key = await aJob();
  // The dead worker: it claimed the job (attempt 1) and its message is gone with it; then it beat no more.
  await db.db.jobStore().claim(key);
  const attempts: number[] = [];
  const startedAt = Date.now();
  await work(async (job) => {
    attempts.push((await row(job.id)).attempts);
    return undefined;
  }, 1000);
  await until(async () => (await row(key.jobId)).status === "succeeded", "the job succeeded");
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900); // not before its beat went stale: a live worker's job is never taken
  expect(attempts).toEqual([2]);
  expect(await row(key.jobId)).toMatchObject({ status: "succeeded", error: null, attempts: 2 });
});

// noon-elo.2.6: the dead worker's message is still `active` in BullMQ, so the sweep's offer under the same jobId is a
// no-op until BullMQ lets go of it. With its defaults (30 s lock, 30 s stall checks) that was ~62 s after the last beat.
test("a job whose dead worker still holds its BullMQ message runs again within staleMs and a few sweeps, not BullMQ's 30 s checks", async () => {
  const key = await aJob();
  // The dead worker: it took the message and claimed the job, then stopped without a word (no completion, no
  // more lock renewals). Its lock is the one our workers take: staleMs long.
  const dead = new Worker("ai", async (message) => {
    await db.db.jobStore().claim(message.data as typeof key);
    await new Promise(() => undefined);
  }, { connection: connection(TEST_REDIS_URL), prefix, lockDuration: 1000 });
  await producer.enqueue(key);
  await until(async () => (await row(key.jobId)).status === "running", "the dead worker claimed it");
  await dead.close(true);
  const startedAt = Date.now();
  await work(() => Promise.resolve(undefined), 1000);
  await until(async () => (await row(key.jobId)).status === "succeeded", "the job succeeded on the live worker", 10_000);
  expect(Date.now() - startedAt).toBeLessThan(10_000); // 1 s stale + a few 100 ms sweeps; BullMQ's defaults took 30 s and more
  expect(await row(key.jobId)).toMatchObject({ status: "succeeded", attempts: 2 });
});

test("while its worker beats, a long job is never taken from it, however long it runs", async () => {
  const key = await aJob();
  let release = (): void => undefined;
  const calls: number[] = [];
  await work(() => {
    calls.push(1);
    return new Promise((resolve) => { release = () => { resolve(undefined); }; });
  }, 500);
  await producer.enqueue(key);
  await until(async () => (await row(key.jobId)).status === "running", "the job runs");
  await new Promise((r) => setTimeout(r, 2000)); // four stale windows
  expect(await row(key.jobId)).toMatchObject({ status: "running", attempts: 1 });
  release();
  await until(async () => (await row(key.jobId)).status === "succeeded", "the job succeeded");
  expect(calls).toHaveLength(1);
});

test("a slow worker that was given up on stops its attempt when it wakes, and writes nothing over the next one", async () => {
  const key = await aJob();
  let sawStop = false;
  await work((_job, cancelled) => new Promise((_, reject) => {
    cancelled.addEventListener("abort", () => { sawStop = true; reject(new Error("stopped")); }, { once: true });
  }), 60_000);
  await producer.enqueue(key);
  await until(async () => (await row(key.jobId)).status === "running", "attempt 1 runs");
  // What the sweep does to a worker silent past staleMs AND another worker's claim after it, as one step: this
  // worker must not get the chance to claim the job again itself in between.
  await db.rawQuery("update jobs set attempts = attempts + 1, started_at = now(), heartbeat_at = now() where id = $1", [key.jobId]);
  await until(() => Promise.resolve(sawStop), "attempt 1 was told to stop");
  await new Promise((r) => setTimeout(r, 300)); // its finish(cancelled) has had time to land, if it could
  expect(await row(key.jobId)).toMatchObject({ status: "running", attempts: 2 });
  await db.db.jobStore().finish({ ...key, attempt: 2 }, "succeeded");
});

test("Redis wiped under a working worker: the running job ends once, the waiting ones are offered again from Postgres and run once", async () => {
  const held = await aJob();
  const waiting = [await aJob(), await aJob()];
  const calls: string[] = [];
  let release = (): void => undefined;
  // One at a time: `held` runs, the other two wait in Redis, and only there.
  await work((job) => {
    calls.push(job.id);
    return job.id === held.jobId ? new Promise((resolve) => { release = () => { resolve(undefined); }; }) : Promise.resolve(undefined);
  }, 60_000, 1);
  const inspect = new Queue("ai", { connection: connection(TEST_REDIS_URL), prefix });
  try {
    await until(async () => (await row(held.jobId)).status === "running" && (await inspect.getWaitingCount()) === 2, "one job runs, two wait in Redis");
    // The wipe: every key of this file's prefix, as FLUSHALL would (the test Redis is shared, so not FLUSHALL itself).
    // One script, so it is atomic as FLUSHALL is: nothing lands between listing the keys and deleting them.
    const redis = await inspect.client;
    redis.defineCommand("wipe", { numberOfKeys: 0, lua: "local keys = redis.call('KEYS', ARGV[1]) for _, key in ipairs(keys) do redis.call('DEL', key) end return #keys" });
    expect(await redis.runCommand("wipe", [`${prefix}:*`])).toBeGreaterThan(0);
    release(); // BullMQ can no longer record this job's end; Postgres can, and that is the one that counts
    await until(async () => (await Promise.all([held, ...waiting].map(async (key) => (await row(key.jobId)).status))).every((s) => s === "succeeded"), "all three succeeded");
  } finally {
    await inspect.close();
  }
  expect(calls.toSorted()).toEqual([held, ...waiting].map((key) => key.jobId).toSorted()); // each ran once: no duplicate job
  for (const key of [held, ...waiting]) expect(await row(key.jobId)).toMatchObject({ status: "succeeded", attempts: 1 });
});
