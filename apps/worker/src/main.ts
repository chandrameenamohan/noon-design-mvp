import { writeFileSync } from "node:fs";
import { createDb } from "@noon/db";
import { createShutdown } from "@noon/process";
import { loadConfig } from "./config.ts";
import { startWorker } from "./worker.ts";

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const worker = await startWorker({
  db,
  redisUrl: config.redisUrl,
  // E3.1: the queue is drained by a handler that does nothing. The AI peer replaces it in E3.2.
  handlers: { ai: () => Promise.resolve() },
  sweepMs: 5000,
  // A worker has no port to probe; the container healthcheck reads this file's age instead.
  onAlive: () => { writeFileSync("/tmp/worker-alive", ""); },
});
process.stdout.write("worker draining queues: ai\n");

// Stop taking jobs and let the ones in flight finish, then close the pool.
const shutdown = createShutdown({ steps: [() => worker.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
