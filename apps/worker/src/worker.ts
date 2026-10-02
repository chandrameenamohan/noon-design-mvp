import { Worker } from "bullmq";
import { includes, type Role, type UsageAmount } from "@noon/contracts";
import type { Db, Job } from "@noon/db";
import { connection, createProducer, describeError, JobRef, QUEUES, type QueueName } from "@noon/queue";

type JobKey = JobRef & { attempt: number };

/** One function per queue. It gets the job as Postgres has it, never what the queue message claims. */
/** `cancelled` is aborted when the user asks for the job to stop (F10): end quickly, keep what was done. */
/**
 * What the job CONSUMED (F12), recorded against its org: the handler's return value, or else the last amount it
 * passed to `spent` (a running total, so a run that fails or is cancelled half way still says what it spent).
 */
/** A process drains ONLY the queues it has a handler for: the AI worker never holds the Docker socket the sandbox needs. */
/** `job.attempt`: the claim this run holds (F28); whatever the handler reports under it lands only while it is the latest. */
export type Handlers = Partial<Record<QueueName, (job: Job & { attempt: number }, cancelled: AbortSignal, spent: (sofar: UsageAmount) => void) => Promise<UsageAmount | undefined>>>;
/** The key a handler's writes go under: the job, and the attempt that holds it (F28), so a stale attempt's write lands nowhere (noon-wv8.6.2). */
export const attemptKey = (job: Job & { attempt?: number }): JobRef & { attempt?: number | undefined } => ({ queue: job.queue, jobId: job.id, orgId: job.orgId, attempt: job.attempt });
/**
 * A job that edits for someone (an AI run, a Ship) starts only while they may still EDIT the document: it may have
 * waited in the queue long after they asked. `role` is theirs now; undefined = no longer a member (noon-dtf.2.4, noon-87s).
 */
export function requireEditor(role: Role | undefined): void {
  if (role === undefined) throw new JobFailure("owner_missing");
  if (!includes(role, "editor")) throw new JobFailure("forbidden");
}
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

type Log = (level: "warn" | "error", message: string, extra?: Record<string, unknown>) => void;

/**
 * One claimed attempt, from its handler to its row's end. However it ends (succeeded, failed, cancelled), what it
 * consumed is recorded ONCE, BEFORE the row is finished (a crash between them leaves `running`, an owned ceiling,
 * rather than losing the spend), and a usage row that cannot be written is logged, never how the run ended.
 */
export async function runAttempt({ jobs, key, job, handler, cancel, log: say = log }: {
  jobs: Pick<ReturnType<Db["jobStore"]>, "recordUsage" | "finish">;
  key: JobKey;
  job: Job & { attempt: number };
  handler: NonNullable<Handlers[QueueName]>;
  cancel: AbortController;
  log?: Log;
}): Promise<void> {
  let consumed: UsageAmount | undefined;
  let status: "succeeded" | "failed" | "cancelled";
  let reason: string | undefined;
  try {
    consumed = (await handler(job, cancel.signal, (sofar) => { consumed = sofar; })) ?? consumed;
    // Asked to stop but finished anyway: the user said cancel, and cancel is what they are told.
    status = cancel.signal.aborted ? "cancelled" : "succeeded";
  } catch (err) {
    if (cancel.signal.aborted) status = "cancelled";
    else {
      // The raw error may hold a path, a query or a secret: it goes to the log, a NAME goes to the user
      // (finish() stores anything that is not a plain name as `internal`).
      say("error", describeError(err), { jobId: key.jobId });
      status = "failed";
      reason = err instanceof JobFailure ? err.reason : "internal";
    }
  }
  if (consumed) await jobs.recordUsage(key, consumed).catch((err: unknown) => { say("error", `usage not recorded: ${describeError(err)}`, { jobId: key.jobId }); });
  await (reason === undefined ? jobs.finish(key, status) : jobs.finish(key, status, reason));
}

/**
 * Whether this process's sweep may give stale jobs away (noon-cs6.3.3). A Postgres outage longer than staleMs makes
 * EVERY running job's beat stale, the healthy ones' too: when Postgres came back it was a race between a live worker's
 * next beat and a sweep, and a lost race restarted the run from step one (a second model call). After a failed store
 * call (a sweep's or a beat's), the sweep waits until Postgres has answered this process again for `graceMs`
 * (staleMs): the same silence a live worker is allowed at any other time, so its beats have landed by then. Chosen
 * over "a worker beats once before any sweep requeues": the beat is in the job's process and the sweep in every
 * process, and that ordering would need them to talk; a process knows its own failures where it decides.
 * ponytail: per process, from its own failures. A store cut from the job's worker only (a partition) still looks like
 * a death to the others, which is what it is to them; a store that HANGS without failing a call is not seen. The cost:
 * a job whose worker really died during the outage is retried staleMs later than it would have been.
 * The ceiling: a process with no job running makes no store call between sweeps (sweepMs), so an outage that falls
 * wholly between two of them is never seen there; if its next sweep lands in the ~cancelPollMs after Postgres is back,
 * before the live worker's first beat, it requeues that healthy job. Upgrade path: decide in the database, not per
 * process: the sweep's requeue counts staleness from the later of the beat and when Postgres last came back (e.g. a
 * row every process stamps on its first answer after a failure, or pg_postmaster_start_time() for restarts).
 */
export function requeueGate(graceMs: number, now: () => number = Date.now): { mayRequeue(): boolean; failed(): void; answered(): void } {
  let upSince: number | undefined = -Infinity; // a fresh process has seen no outage
  return {
    mayRequeue: () => upSince !== undefined && now() - upSince >= graceMs,
    failed: () => { upSince = undefined; },
    answered: () => { upSince ??= now(); },
  };
}

export async function startWorker({ db, redisUrl, prefix, handlers, concurrency = {}, sweepMs = 30_000, cancelPollMs = 1000, staleMs = 15_000, maxAttempts = 3, onAlive }: {
  db: Db;
  redisUrl: string;
  prefix?: string;
  handlers: Handlers;
  /**
   * Jobs of each queue at once (default 4). Per queue, because they cost different things: an AI run
   * is a model call, a sandbox job holds a container for as long as someone has the document open.
   * One shared pool would let a burst of either starve the other.
   */
  concurrency?: Partial<Record<QueueName, number>>;
  sweepMs?: number;
  /** How often a running job beats (F28) and asks "has someone cancelled you?" (F10 allows 3 s in all). */
  cancelPollMs?: number;
  /**
   * A running job whose last beat is older than this was left by a dead worker (`kill -9` says nothing): the sweep
   * gives it another attempt. Many beats long, so a busy event loop or a slow query is not taken for a death; and
   * if it is, the attempt fence makes the slow worker stop instead of finishing twice.
   */
  staleMs?: number;
  /** Claims a job may have in all. A job that kills its worker every time must still END: then it fails as `worker_lost`. */
  maxAttempts?: number;
  /** Called after every sweep in which Postgres AND Redis answered: the container healthcheck hangs on it. */
  onAlive?: () => void;
}): Promise<RunningWorker> {
  const jobs = db.jobStore();
  const scoped = prefix === undefined ? {} : { prefix };
  // Every store call the sweep makes, and every beat, says whether Postgres answers this process (noon-cs6.3.3).
  const store = requeueGate(staleMs);
  const fromStore = <T>(call: Promise<T>): Promise<T> => call.then((value) => { store.answered(); return value; }, (err: unknown) => { store.failed(); throw err; });

  async function run(data: unknown): Promise<void> {
    const ref = JobRef.parse(data);
    // A ref for a queue this process does not handle (misrouted, or forged by someone with the Redis
    // password) is left for its own worker: claiming it first would fail someone else's job as `internal`.
    if (handlers[ref.queue] === undefined) return;
    // Claiming is the ONLY way to start: queued -> running, in one statement. A duplicate or stale
    // message finds nothing to claim and ends here, so a job runs at most once per claim.
    const job = await jobs.claim(ref);
    if (!job) return;
    // Everything this attempt writes names it: once the job is someone else's, it writes nothing.
    const mine = { ...ref, attempt: job.attempt };
    // ponytail: a beat per running job per second (a handful at most). Redis pub/sub if a second ever matters.
    // The signal only ASKS. "Ends within 3 s" is the handler's promise (ai.ts races its work against it):
    // a handler for a new queue that ignores the signal holds its slot, and a polite shutdown, for ever.
    // `lost` aborts it too: this worker went silent for longer than staleMs and the job was given to another.
    const cancel = new AbortController();
    const watch = setInterval(() => {
      fromStore(jobs.heartbeat(mine)).then((state) => {
        if (state === "lost" && !cancel.signal.aborted) log("warn", "job taken over after a silence: stopping this attempt", { jobId: ref.jobId, attempt: job.attempt });
        if (state !== "running") cancel.abort();
      }, () => undefined); // a failed beat is tried again in a second; staleMs is many of them
    }, cancelPollMs);
    try {
      const handler = handlers[job.queue]; // the row's queue, not the message's
      if (!handler) throw new Error(`no handler for the ${job.queue} queue`); // unreachable: only handled queues are drained
      await runAttempt({ jobs, key: mine, job, handler, cancel });
    } finally {
      clearInterval(watch);
    }
  }

  // BullMQ's own retries and stalled-job checks are not what brings a job back: Postgres is (the sweep below).
  // A message whose worker died is either re-delivered by BullMQ (claim() refuses it while the row still says
  // running, then takes it once the sweep has put the row back) or dropped, and the sweep offers the row again.
  // But BullMQ must let go of it: while the dead worker's message is still `active`, the sweep's offer under the same
  // jobId is a no-op, and with BullMQ's defaults (a 30 s lock, a stall check every 30 s, two checks to see a stall) a
  // killed worker's job came back ~62 s after its last beat, whatever staleMs said (noon-elo.2.6). So the lock lasts
  // staleMs and the check runs every sweep: the message is free about when the row is (staleMs and a few sweeps: two
  // stall checks, and one more offer if the freed message reached a worker before the row was queued again).
  // A live worker frozen past staleMs loses its message too, which is harmless: claim() refuses it while the row runs.
  const workers = QUEUES.filter((name) => handlers[name] !== undefined).map((name) => {
    const worker = new Worker(name, (message) => run(message.data), { connection: connection(redisUrl), concurrency: concurrency[name] ?? 4, lockDuration: staleMs, stalledInterval: sweepMs, ...scoped });
    worker.on("error", (err) => log("warn", describeError(err), { queue: name })); // without a listener, a Redis hiccup is an uncaught exception
    return worker;
  });
  await Promise.all(workers.map((w) => w.waitUntilReady()));

  // Redis is not the truth (SPEC §2.9): it can be flushed, and the api can die between its INSERT
  // and its enqueue. Whatever Postgres still calls `queued` is offered again; jobId + claim() make
  // a second offer harmless. ponytail: a poll; LISTEN/NOTIFY or an outbox if `sweepMs` is ever too slow.
  // First, F28: a job whose worker died (its beat went stale) is made `queued` again, so this same pass offers it.
  // Every worker process sweeps every queue: the AI worker brings back a dead sandbox worker's job, and the other way round.
  const producer = createProducer({ redisUrl, ...scoped });
  let sweeping: Promise<void> | undefined;
  const sweep = (): Promise<void> => (sweeping ??= sweepOnce().finally(() => (sweeping = undefined)));
  async function sweepOnce(): Promise<void> {
    try {
      await producer.ping(); // with nothing queued the loop below never touches Redis, and "alive" would mean "Postgres is up"
      if (store.mayRequeue()) {
        const stale = await fromStore(jobs.requeueStale(staleMs, maxAttempts));
        if (stale.requeued + stale.lost > 0) log("warn", "jobs left running by a dead worker", stale);
      }
      // One refused offer must not hide the 99 behind it: it stays `queued` and is offered again next time.
      for (const ref of await fromStore(jobs.queued(100))) await producer.enqueue(ref).catch((err: unknown) => log("warn", `offer failed: ${describeError(err)}`, { jobId: ref.jobId }));
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
