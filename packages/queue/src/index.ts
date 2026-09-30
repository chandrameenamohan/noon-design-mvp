import { Queue, type ConnectionOptions } from "bullmq";
import { Id } from "@noon/contracts";
import { z } from "zod";

// ponytail: only the queues an epic already needs. The git peer (E5.3a) has no queue: its inbox is in Postgres.
export const QUEUES = ["ai", "sandbox", "ship"] as const;
export type QueueName = (typeof QUEUES)[number];

/**
 * ALL a queue message carries: where to look in Postgres. The job's input and status live in the
 * `jobs` table, so a lost, duplicated or stale message can never change what a job is or does.
 */
export const JobRef = z.strictObject({ queue: z.enum(QUEUES), jobId: Id, orgId: Id });
export type JobRef = z.infer<typeof JobRef>;

/** A redis:// or rediss:// URL with a host. Parsed once at startup like every other address. */
export const RedisUrl = z.string({ error: "REDIS_URL is required" }).refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "redis:" || url.protocol === "rediss:") && url.hostname !== "";
}, "REDIS_URL must be a redis:// URL with a host");

export const connection = (redisUrl: string, extra: Partial<ConnectionOptions> = {}): ConnectionOptions => ({ url: redisUrl, ...extra });

/** Resolves only after a round trip to Redis. */
export type Producer = { enqueue: (ref: JobRef) => Promise<void>; ping: () => Promise<void>; close: () => Promise<void> };

/**
 * An error as one log-safe string. ONLY ever the message: an ioredis error object carries the
 * command it belonged to, and for a failed AUTH that is the password. And never trust the message
 * to exist: a refused connect to a host with an IPv6 and an IPv4 address is an AggregateError with "".
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message !== "") return err.message;
  if (err instanceof AggregateError) return err.errors.map(describeError).join("; ");
  return err.name;
}

/** The sending side. `prefix` namespaces the Redis keys (tests use one per file). */
export function createProducer({ redisUrl, prefix, timeoutMs = 2000 }: { redisUrl: string; prefix?: string; timeoutMs?: number }): Producer {
  const queues = new Map<QueueName, Queue>();
  const queueFor = (name: QueueName): Queue => {
    let queue = queues.get(name);
    if (!queue) {
      // A producer must FAIL when Redis is away, not hold the HTTP request while ioredis queues the
      // command and retries for ever: the row in Postgres is safe and the worker's sweep will find it.
      queue = new Queue(name, { connection: connection(redisUrl, { enableOfflineQueue: false }), ...(prefix === undefined ? {} : { prefix }) });
      queue.on("error", (err) => process.stderr.write(`${JSON.stringify({ level: "warn", source: "queue", message: describeError(err) })}\n`));
      queues.set(name, queue);
    }
    return queue;
  };
  // While Redis is away ioredis reconnects for ever and nothing settles (measured: the HTTP request
  // simply hung, and 80 s later still had). The caller gets an answer within the deadline instead.
  async function withinDeadline(work: (queue: Queue) => Promise<unknown>, name: QueueName): Promise<void> {
    const queue = queueFor(name);
    const attempt = queue.waitUntilReady().then(() => work(queue));
    // When the deadline wins, `attempt` is still out there and may fail later. A rejection nobody
    // handles ends a Node process. (The case the review reproduced, a close() in mid-handshake, is
    // cured in close() below and tested; this line is for the failures we have not met yet.)
    attempt.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error(`redis did not answer within ${String(timeoutMs)} ms`)); }, timeoutMs);
    });
    try {
      await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    // jobId = our job's id: a second add while the first is waiting is dropped by BullMQ. Finished
    // messages are removed at once; Postgres keeps the history, and a re-delivery is refused there.
    enqueue: (ref) => withinDeadline((queue) => queue.add(ref.queue, ref, { jobId: ref.jobId, removeOnComplete: true, removeOnFail: true }), ref.queue),
    ping: () => withinDeadline((queue) => queue.getWaitingCount(), "ai"), // any command that must reach Redis; this one is typed
    async close() {
      await Promise.all([...queues.values()].map(async (queue) => {
        // Closing a connection that is still in its handshake makes ioredis reject a promise of its
        // own that nobody holds ("write EPIPE", caught by the test): let the handshake end first.
        // With Redis away it never ends, so this wait is bounded too.
        await Promise.race([queue.waitUntilReady().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000).unref())]); // its own bound: a caller's tiny enqueue deadline must not cut the handshake short
        await queue.close();
      }));
    },
  };
}
