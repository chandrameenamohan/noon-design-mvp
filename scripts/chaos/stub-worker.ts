// The chaos checks' AI worker (E9.2a): the REAL worker loop (claim, heartbeat, stale sweep), the REAL AI handler and
// its peer, with a scripted agent in place of the model, so a run is the same on every attempt and costs nothing.
// It runs INSIDE the worker image, with this file mounted (kill-worker-resumes.ts starts it with `docker run`), so it
// has the compose network and the worker's own environment. Relative imports only: the image installs no root
// dev dependencies, and each workspace package finds its own.
//   instruction "nodes=N": N Stacks under the root, one every STUB_STEP_MS (default 300), then the run succeeds.
import { createDb } from "../../packages/db/src/index.ts";
import { manifest } from "../../packages/design-system/src/index.ts";
import { createAiHandler, type RunAgent } from "../../apps/worker/src/ai.ts";
import { loadConfig } from "../../apps/worker/src/config.ts";
import { syncSessions } from "../../apps/worker/src/live.ts";
import { startWorker } from "../../apps/worker/src/worker.ts";

const config = loadConfig(process.env);
const stepMs = Number(process.env["STUB_STEP_MS"] ?? "300");
const db = createDb({ connectionString: config.databaseUrl });
const sync = syncSessions(config.sessions, config.redisUrl);

const scripted: RunAgent = async ({ instruction, tools, signal }) => {
  const count = Number(/^nodes=(\d{1,3})$/u.exec(instruction)?.[1] ?? "0");
  const add = tools.find((each) => each.name === "add_node");
  if (!add) throw new Error("no add_node tool");
  for (let step = 0; step < count && !signal.aborted; step++) {
    const result = await add.run({ parentId: "root", component: "Stack" });
    if (!result.ok) throw new Error(`step ${String(step)}: ${result.text}`); // a replayed step must be DONE, never refused
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return { model: "stub", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
};

const never = new AbortController().signal; // no polite shutdown: this process only ever dies by kill -9, or is removed
const ai = createAiHandler({ sessions: sync.sessions, manifest, oauthToken: "stub", runAgent: scripted, ready: Promise.resolve(), stopping: never, roleOf: async (documentId, userId) => (await db.getDocumentForMember(documentId, userId))?.role, report: (job, progress) => db.jobStore().report({ queue: "ai", jobId: job.id, orgId: job.orgId, attempt: job.attempt }, progress) });
await startWorker({ db, redisUrl: config.redisUrl, handlers: { ai }, sweepMs: 1000 });
process.stdout.write("stub worker draining queues: ai\n");
