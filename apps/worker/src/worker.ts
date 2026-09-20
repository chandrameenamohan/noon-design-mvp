import { Worker } from "bullmq";
import type { Db, Job } from "@noon/db";
import { connection, createProducer, describeError, JobRef, QUEUES, type QueueName } from "@noon/queue";

/** One function per queue. It gets the job as Postgres has it, never what the queue message claims. */
/** `cancelled` is aborted when the user asks for the job to stop (F10): end quickly, keep what was done. */
export type Handlers = Record<QueueName, (job: Job, cancelled: AbortSignal) => Promise<void>>;
export type RunningWorker = { close(): Promise<void> };

/** Thrown by a handler to fail a job with a reason the USER may read. Any other error is stored as `internal`. */
export class JobFailure extends Error {
  readonly reason: string;
  /** `detail` is for the LOG only (it may quote a provider's error); the user only ever sees `reason`. */
  constructor(reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
  }
}

const log = (level: "warn" | "error", message: string, extra: Record<string, unknown> = {}) =>
  process.stderr.write(`${JSON.stringify({ level, source: "worker", message, ...extra })}\n`);

export async function startWorker({ db, redisUrl, prefix, handlers, sweepMs = 30_000, cancelPollMs = 1000, onAlive }: {
  db: Db;
  redisUrl: string;
  prefix?: string;
  handlers: Handlers;
  sweepMs?: number;
  /** How often a running job's row is asked "has someone cancelled you?". F10 allows 3 s in all. */
  cancelPollMs?: number;
  /** Called after every sweep in which Postgres AND Redis answered: the container healthcheck hangs on it. */
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
    // ponytail: a poll per running job (a handful at most). Redis pub/sub if a second ever matters.
    // The signal only ASKS. "Ends within 3 s" is the handler's promise (ai.ts races its work against it):
    // a handler for a new queue that ignores the signal holds its slot, and a polite shutdown, for ever.
    const cancel = new AbortController();
    const watch = setInterval(() => {
      jobs.cancelRequested(ref).then((asked) => { if (asked) cancel.abort(); }, () => undefined); // a failed look is tried again in a second
    }, cancelPollMs);
    try {
      await handlers[job.queue](job, cancel.signal); // the row's queue, not the message's
      // Asked to stop but finished anyway: the user said cancel, and cancel is what they are told.
      await jobs.finish(ref, cancel.signal.aborted ? "cancelled" : "succeeded");
    } catch (err) {
      if (cancel.signal.aborted) {
        await jobs.finish(ref, "cancelled");
        return;
      }
      // The raw error may hold a path, a query or a secret: it goes to the log, a NAME goes to the user
      // (finish() stores anything that is not a plain name as `internal`).
      log("error", describeError(err), { jobId: ref.jobId });
      await jobs.finish(ref, "failed", err instanceof JobFailure ? err.reason : "internal");
    } finally {
      clearInterval(watch);
    }
  }

  // ponytail: one attempt, no retries, and a job left `running` by a killed worker stays there.
  // Retries, heartbeats and resuming stale jobs are E9 (F28).
  const workers = QUEUES.map((name) => {
    const worker = new Worker(name, (message) => run(message.data), { connection: connection(redisUrl), concurrency: 4, ...scoped });
    worker.on("error", (err) => log("warn", describeError(err), { queue: name })); // without a listener, a Redis hiccup is an uncaught exception
    return worker;
  });
  await Promise.all(workers.map((w) => w.waitUntilReady()));

  // Redis is not the truth (SPEC §2.9): it can be flushed, and the api can die between its INSERT
  // and its enqueue. Whatever Postgres still calls `queued` is offered again; jobId + claim() make
  // a second offer harmless. ponytail: a poll; LISTEN/NOTIFY or an outbox if `sweepMs` is ever too slow.
  const producer = createProducer({ redisUrl, ...scoped });
  let sweeping: Promise<void> | undefined;
  const sweep = (): Promise<void> => (sweeping ??= sweepOnce().finally(() => (sweeping = undefined)));
  async function sweepOnce(): Promise<void> {
    try {
      await producer.ping(); // with nothing queued the loop below never touches Redis, and "alive" would mean "Postgres is up"
      // One refused offer must not hide the 99 behind it: it stays `queued` and is offered again next time.
      for (const ref of await jobs.queued(100)) await producer.enqueue(ref).catch((err: unknown) => log("warn", `offer failed: ${describeError(err)}`, { jobId: ref.jobId }));
      onAlive?.();
    } catch (err) {
      log("warn", `sweep failed: ${describeError(err)}`);
    }
  }
  await sweep();
  const timer = setInterval(() => void sweep(), sweepMs);

  return {
    async close() {
      clearInterval(timer);
      await sweeping; // never close the producer under a sweep that is using it
      // Normally: stop fetching and wait for the jobs in flight. But BullMQ's polite close talks to
      // Redis, and with Redis gone it waits for a connection that is not coming back: `docker stop`
      // took 9 s and ended in exit 1 (found by the re-verify). So ask Redis first; no answer = force.
      // Nothing is lost by that: a job's result lives in Postgres, not in BullMQ's bookkeeping.
      const redisAnswers = await producer.ping().then(() => true, () => false);
      // A close that fails because the connection is ALREADY gone has nothing left to do: say so, carry on.
      const gone = (err: unknown): void => void log("warn", `close: ${describeError(err)}`);
      await Promise.all(workers.map((w) => w.close(!redisAnswers).catch(gone)));
      await producer.close().catch(gone);
    },
  };
}
