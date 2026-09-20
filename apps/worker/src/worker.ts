import { Worker } from "bullmq";
import type { Db, Job } from "@noon/db";
import { connection, createProducer, JobRef, QUEUES, type QueueName } from "@noon/queue";

/** One function per queue. It gets the job as Postgres has it, never what the queue message claims. */
export type Handlers = Record<QueueName, (job: Job) => Promise<void>>;
export type RunningWorker = { close(): Promise<void> };

/** Thrown by a handler to fail a job with a reason the USER may read. Any other error is stored as `internal`. */
export class JobFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const log = (level: "warn" | "error", message: string, extra: Record<string, unknown> = {}) =>
  process.stderr.write(`${JSON.stringify({ level, source: "worker", message, ...extra })}\n`);

export async function startWorker({ db, redisUrl, prefix, handlers, sweepMs = 30_000, onAlive }: {
  db: Db;
  redisUrl: string;
  prefix?: string;
  handlers: Handlers;
  sweepMs?: number;
  /** Called after every sweep that reached both stores: the container healthcheck hangs on it. */
  onAlive?: () => void;
}): Promise<RunningWorker> {
  const jobs = db.jobStore();
  const scoped = prefix === undefined ? {} : { prefix };

  async function run(data: unknown): Promise<void> {
    const ref = JobRef.parse(data);
    // Claiming is the ONLY way to start: queued -> running, in one statement. A duplicate or stale
    // message finds nothing to claim and ends here, so a job runs at most once per claim.
    const job = await jobs.claim(ref);
    if (!job) return;
    try {
      await handlers[ref.queue](job);
      await jobs.finish(ref, "succeeded");
    } catch (err) {
      // The raw error may hold a path, a query or a secret: it goes to the log, a NAME goes to the user.
      log("error", err instanceof Error ? err.message : String(err), { jobId: ref.jobId });
      await jobs.finish(ref, "failed", err instanceof JobFailure ? err.reason : "internal");
    }
  }

  // ponytail: one attempt, no retries, and a job left `running` by a killed worker stays there.
  // Retries, heartbeats and resuming stale jobs are E9 (F28).
  const workers = QUEUES.map((name) => {
    const worker = new Worker(name, (message) => run(message.data), { connection: connection(redisUrl), concurrency: 4, ...scoped });
    worker.on("error", (err) => log("warn", err.message, { queue: name })); // without a listener, a Redis hiccup is an uncaught exception
    return worker;
  });
  await Promise.all(workers.map((w) => w.waitUntilReady()));

  // Redis is not the truth (SPEC §2.9): it can be flushed, and the api can die between its INSERT
  // and its enqueue. Whatever Postgres still calls `queued` is offered again; jobId + claim() make
  // a second offer harmless. ponytail: a poll; LISTEN/NOTIFY or an outbox if 30 s is ever too slow.
  const producer = createProducer({ redisUrl, ...scoped });
  let sweeping = false;
  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const ref of await jobs.queued(100)) await producer.enqueue(ref);
      onAlive?.();
    } catch (err) {
      log("warn", `sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sweeping = false;
    }
  }
  await sweep();
  const timer = setInterval(() => void sweep(), sweepMs);

  return {
    async close() {
      clearInterval(timer);
      await Promise.all(workers.map((w) => w.close())); // waits for jobs in flight
      await producer.close();
    },
  };
}
