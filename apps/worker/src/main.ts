import { writeFileSync } from "node:fs";
import { createDb } from "@noon/db";
import { manifest } from "@noon/design-system";
import { createShutdown } from "@noon/process";
import { describeError } from "@noon/queue";
import { createAiHandler } from "./ai.ts";
import { loadConfig } from "./config.ts";
import { createPreviewHandler } from "./preview.ts";
import { reapSandboxes } from "./sandbox.ts";
import { probeTools, sdkRunner } from "./sdk.ts";
import { buildTools } from "./tools.ts";
import { startWorker, type Handlers } from "./worker.ts";

const config = loadConfig(process.env); // refuses to start when ANTHROPIC_API_KEY is set
const db = createDb({ connectionString: config.databaseUrl });

const stopping = new AbortController();
const stillMember = async (documentId: string, userId: string): Promise<boolean> => (await db.getDocumentForMember(documentId, userId)) !== undefined;
const log = (message: string): void => void process.stderr.write(`${JSON.stringify({ level: "error", source: "worker", message })}\n`);
let reaper: NodeJS.Timeout | undefined;

// ONE queue per process (config.ts says why). Each branch builds only what its queue needs.
function aiHandlers(): Handlers {
  // Once, at startup, against the REAL SDK: are our tools really registered, and nothing else? It
  // needs no credentials and spends nothing. A failure does not stop the worker (queued runs must
  // still reach a terminal status the user can read): it fails every run as `tools_missing`.
  const ready = probeTools(buildTools({ submit: () => ({ ok: false, reason: "not_ready" }), get doc(): never { throw new Error("the probe calls no tool"); } }, manifest));
  ready.then(() => process.stdout.write("agent tools registered and isolated\n"), (err: unknown) => { log(`agent tool probe failed: ${describeError(err)}`); });
  return { ai: createAiHandler({ sessions: config.sessions, manifest, oauthToken: config.oauthToken, ready, stopping: stopping.signal, stillMember, runAgent: sdkRunner({ model: config.model, oauthToken: config.oauthToken ?? "" }) }) };
}
function sandboxHandlers(): Handlers {
  const sandbox = { image: config.sandbox.image, docker: config.sandbox.docker, pool: config.sandbox.pool };
  // The reaper: every sandbox whose document has no sandbox job in flight, and none finished in the
  // last five minutes, is removed. Postgres says what is in use; the containers are only a cache of it.
  // ponytail: one timer, one sweep at a time; a lease if two sandbox workers ever run (E7).
  let reaping = false;
  reaper = setInterval(() => {
    if (reaping) return;
    reaping = true;
    reapSandboxes(async () => new Set(await db.jobStore().sandboxesInUse(5 * 60_000)), sandbox)
      .catch((err: unknown) => { log(`reap failed: ${describeError(err)}`); })
      .finally(() => { reaping = false; });
  }, 30_000);
  return {
    sandbox: createPreviewHandler({
      sessions: config.sessions, manifest, sandbox, stopping: stopping.signal, stillMember,
      reportUrl: (job, url) => db.jobStore().report({ queue: "sandbox", jobId: job.id, orgId: job.orgId }, url === null ? null : { url }),
    }),
  };
}

const worker = await startWorker({
  db,
  redisUrl: config.redisUrl,
  handlers: config.queue === "ai" ? aiHandlers() : sandboxHandlers(),
  concurrency: { sandbox: config.sandbox.concurrency },
  sweepMs: 5000,
  // A worker has no port to probe; the container healthcheck reads this file's age instead.
  onAlive: () => { writeFileSync("/tmp/worker-alive", ""); },
});
process.stdout.write(config.queue === "ai"
  ? `worker draining queues: ai (model ${config.model}, token ${config.oauthToken === undefined ? "MISSING: every run will fail as token_missing" : "present"})\n`
  : `worker draining queues: sandbox (image ${config.sandbox.image}, at most ${String(config.sandbox.concurrency)} at once)\n`);

// Tell the runs in flight to end NOW (as failed/worker_stopped: a row left `running` would block its
// document's next run for ever), stop taking jobs, wait for those endings to be written, close the pool.
const shutdown = createShutdown({ steps: [() => { clearInterval(reaper); stopping.abort(); return worker.close(); }, () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
