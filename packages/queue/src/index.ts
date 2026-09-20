import { Queue, type ConnectionOptions } from "bullmq";
import { Id } from "@noon/contracts";
import { z } from "zod";

// ponytail: only the queue an epic already needs. `git`, `ship` and `sandbox` arrive with their epics.
export const QUEUES = ["ai"] as const;
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

export type Producer = { enqueue: (ref: JobRef) => Promise<void>; close: () => Promise<void> };

/** The sending side. `prefix` namespaces the Redis keys (tests use one per file). */
export function createProducer({ redisUrl, prefix, timeoutMs = 2000 }: { redisUrl: string; prefix?: string; timeoutMs?: number }): Producer {
  const queues = new Map<QueueName, Queue>();
  const queueFor = (name: QueueName): Queue => {
    let queue = queues.get(name);
    if (!queue) {
      // A producer must FAIL when Redis is away, not hold the HTTP request while ioredis queues the
      // command and retries for ever: the row in Postgres is safe and the worker's sweep will find it.
      queue = new Queue(name, { connection: connection(redisUrl, { enableOfflineQueue: false }), ...(prefix === undefined ? {} : { prefix }) });
      queue.on("error", (err) => process.stderr.write(`${JSON.stringify({ level: "warn", source: "queue", message: err.message })}\n`));
      queues.set(name, queue);
    }
    return queue;
  };
  return {
    async enqueue(ref) {
      const queue = queueFor(ref.queue);
      // While Redis is away ioredis reconnects for ever and waitUntilReady() never settles (measured:
      // the HTTP request simply hung). The caller gets an answer within the deadline instead.
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`redis did not answer within ${String(timeoutMs)} ms`)); }, timeoutMs);
      });
      try {
        await Promise.race([
          // jobId = our job's id: a second add while the first is waiting is dropped by BullMQ. Finished
          // messages are removed at once; Postgres keeps the history, and a re-delivery is refused there.
          queue.waitUntilReady().then(() => queue.add(ref.queue, ref, { jobId: ref.jobId, removeOnComplete: true, removeOnFail: true })),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}
