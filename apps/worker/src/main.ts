import { writeFileSync } from "node:fs";
import { createDb } from "@noon/db";
import { manifest } from "@noon/design-system";
import { createShutdown } from "@noon/process";
import { describeError } from "@noon/queue";
import { createAiHandler } from "./ai.ts";
import { loadConfig } from "./config.ts";
import { probeTools, sdkRunner } from "./sdk.ts";
import { buildTools } from "./tools.ts";
import { startWorker } from "./worker.ts";

const config = loadConfig(process.env); // refuses to start when ANTHROPIC_API_KEY is set
const db = createDb({ connectionString: config.databaseUrl });

// Once, at startup, against the REAL SDK: are our tools really registered, and nothing else? It
// needs no credentials and spends nothing. A failure does not stop the worker (queued runs must
// still reach a terminal status the user can read): it fails every run as `tools_missing`.
const ready = probeTools(buildTools({ submit: () => ({ ok: false, reason: "not_ready" }), get doc(): never { throw new Error("the probe calls no tool"); } }, manifest));
ready.then(
  () => process.stdout.write("agent tools registered and isolated\n"),
  (err: unknown) => process.stderr.write(`${JSON.stringify({ level: "error", source: "worker", message: `agent tool probe failed: ${describeError(err)}` })}\n`),
);

const worker = await startWorker({
  db,
  redisUrl: config.redisUrl,
  handlers: { ai: createAiHandler({ sessions: config.sessions, manifest, oauthToken: config.oauthToken, ready, runAgent: sdkRunner({ model: config.model, oauthToken: config.oauthToken ?? "" }) }) },
  sweepMs: 5000,
  // A worker has no port to probe; the container healthcheck reads this file's age instead.
  onAlive: () => { writeFileSync("/tmp/worker-alive", ""); },
});
process.stdout.write(`worker draining queues: ai (model ${config.model}, token ${config.oauthToken === undefined ? "MISSING: every run will fail as token_missing" : "present"})\n`);

// Stop taking jobs and let the ones in flight finish, then close the pool.
const shutdown = createShutdown({ steps: [() => worker.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
