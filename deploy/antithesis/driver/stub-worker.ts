// The harness's AI worker (SPEC §4a A1: "the AI peer is a scripted stub, no model calls, no token in any image"):
// the REAL worker loop (claim, heartbeat, stale sweep, cancel), the REAL AI handler, its tools and its peer, from the
// app image, with a scripted agent where the model would be. So a run is the same on every attempt, costs nothing,
// and is slow enough to be cut mid-way (as scripts/chaos/stub-worker.ts, which this follows, and e2e/stub-worker.ts).
//   instruction "nodes=N ...":         N Stacks under the root, one every STUB_STEP_MS, then the run succeeds.
//   instruction "nodes=N fail=K ...":  the provider says no after K of them (failed/rate_limited, K ops applied).
// The three timings below are startWorker's own parameters; the app's main.ts takes their defaults, this harness
// shortens them through its compose file (owner, 2026-10-01: configuration only, never code).
import { writeFileSync } from "node:fs";
import { createDb } from "@noon/db";
import { manifest } from "@noon/design-system";
import { createAiHandler, type RunAgent } from "../../../apps/worker/src/ai.ts";
import { loadConfig } from "../../../apps/worker/src/config.ts";
import { syncSessions } from "../../../apps/worker/src/live.ts";
import { JobFailure, startWorker } from "../../../apps/worker/src/worker.ts";

const config = loadConfig(process.env);
const positive = (name: string, fallback: number): number => Number(process.env[name] ?? "") || fallback;
const stepMs = positive("STUB_STEP_MS", 300);
const db = createDb({ connectionString: config.databaseUrl });
const sync = syncSessions(config.sessions, config.redisUrl);

const scripted: RunAgent = async ({ instruction, tools, signal }) => {
  const count = Number(/^nodes=(\d{1,3})\b/u.exec(instruction)?.[1] ?? "0");
  const failAfter = Number(/\bfail=(\d{1,3})\b/u.exec(instruction)?.[1] ?? "-1");
  const add = tools.find((each) => each.name === "add_node");
  if (!add) throw new Error("no add_node tool");
  for (let step = 0; step < count && !signal.aborted; step++) {
    if (step === failAfter) throw new JobFailure("rate_limited");
    const result = await add.run({ parentId: "root", component: "Stack" });
    if (!result.ok) throw new Error(`step ${String(step)}: ${result.text}`); // a replayed step must be DONE, never refused
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return { model: "stub", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
};

const never = new AbortController().signal; // no polite shutdown: this process ends by kill -9, or with its container
const ai = createAiHandler({ sessions: sync.sessions, manifest, oauthToken: "stub", runAgent: scripted, ready: Promise.resolve(), stopping: never, roleOf: async (documentId, userId) => (await db.getDocumentForMember(documentId, userId))?.role, report: (job, progress) => db.jobStore().report({ queue: "ai", jobId: job.id, orgId: job.orgId, attempt: job.attempt }, progress) });
await startWorker({ db, redisUrl: config.redisUrl, handlers: { ai }, sweepMs: positive("SWEEP_MS", 1000), cancelPollMs: 500, staleMs: positive("STALE_MS", 15_000), onAlive: () => { writeFileSync("/tmp/worker-alive", ""); } });
process.stdout.write("stub worker draining queues: ai\n");
