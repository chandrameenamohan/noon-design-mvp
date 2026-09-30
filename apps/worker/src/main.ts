import { writeFileSync } from "node:fs";
import { createDb } from "@noon/db";
import { manifest } from "@noon/design-system";
import { createShutdown } from "@noon/process";
import { describeError } from "@noon/queue";
import { createAiHandler } from "./ai.ts";
import { loadConfig } from "./config.ts";
import { createGitPeer } from "./git.ts";
import { createPreviewHandler } from "./preview.ts";
import { createPushApplier, keepConflict } from "./push.ts";
import { syncSessions } from "./live.ts";
import { reapSandboxes } from "./sandbox.ts";
import { createShipHandler } from "./ship.ts";
import { probeTools, sdkRunner } from "./sdk.ts";
import { buildTools } from "./tools.ts";
import { startWorker, type Handlers } from "./worker.ts";

const config = loadConfig(process.env); // refuses to start when ANTHROPIC_API_KEY is set
const db = createDb({ connectionString: config.databaseUrl });
const sync = syncSessions(config.sessions, config.redisUrl);

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
  return { ai: createAiHandler({ sessions: sync.sessions, manifest, oauthToken: config.oauthToken, ready, stopping: stopping.signal, stillMember, report: (job, progress) => db.jobStore().report({ queue: "ai", jobId: job.id, orgId: job.orgId, attempt: job.attempt }, progress), runAgent: sdkRunner({ model: config.model, oauthToken: config.oauthToken ?? "" }) }) };
}
function sandboxHandlers(): Handlers {
  const sandbox = { image: config.sandbox.image, docker: config.sandbox.docker, pool: config.sandbox.pool, proxyPort: config.sandbox.proxyPort, previewKey: config.sandbox.previewKey, seed: config.sandbox.seed };
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
      sessions: sync.sessions, manifest, sandbox, stopping: stopping.signal, stillMember,
      reportUrl: (job, url) => db.jobStore().report({ queue: "sandbox", jobId: job.id, orgId: job.orgId }, url === null ? null : { url }),
    }),
  };
}

// E5.5 (F17): Ship. Its own process, as it holds the Gitea token that may push; the AI worker never does.
function shipHandlers(): Handlers {
  return {
    ship: createShipHandler({
      sessions: sync.sessions, manifest, seed: config.sandbox.seed, stopping: stopping.signal, stillMember,
      report: (job, output) => db.jobStore().report({ queue: "ship", jobId: job.id, orgId: job.orgId }, output),
    }),
  };
}

// A worker has no port to probe; the container healthcheck reads this file's age instead.
const onAlive = (): void => { writeFileSync("/tmp/worker-alive", ""); };

// The git peer (E5.3a) is driven by its inbox in Postgres, not by queue messages: the webhook has no org to
// put in one. ponytail: a 1 s poll of a partial index; LISTEN/NOTIFY if a second's delay ever matters.
function startGitPeer(): Promise<{ stop(): Promise<void> }> {
  const store = db.gitStore();
  const toOps = createPushApplier({ sessions: sync.sessions, manifest, documentOrg: (documentId) => store.documentOrg(documentId), shippedCommit: (sha) => store.shippedCommit(sha), pushedNodeIds: (documentId, commit) => store.pushedNodeIds(documentId, commit) });
  const peer = createGitPeer({
    seed: config.sandbox.seed, dir: config.gitDir, store, log,
    // E5.3b: each page becomes ops through peer-client. E5.4: a refused one becomes the document's conflict banner.
    apply: async (event, page, base) => {
      const outcome = await toOps(event, page, base);
      await keepConflict(store, event, page, outcome);
      process.stdout.write(`${JSON.stringify({ level: "info", source: "git", ref: event.ref, commit: event.after, document: page.documentId, ...outcome })}\n`);
    },
  });
  return peer.start({ pollMs: 1000, reconcileMs: 30_000, onAlive });
}

const worker = config.queue === "git"
  ? await startGitPeer().then((peer) => ({ close: () => peer.stop() }))
  : await startWorker({
    db,
    redisUrl: config.redisUrl,
    handlers: config.queue === "ai" ? aiHandlers() : config.queue === "ship" ? shipHandlers() : sandboxHandlers(),
    concurrency: { sandbox: config.sandbox.concurrency },
    sweepMs: 5000,
    onAlive,
  });
process.stdout.write(config.queue === "ai"
  ? `worker draining queues: ai (model ${config.model}, token ${config.oauthToken === undefined ? "MISSING: every run will fail as token_missing" : "present"})\n`
  : config.queue === "git"
    ? `git peer watching ${config.sandbox.seed.url} (token ${config.sandbox.seed.auth === undefined ? "MISSING" : "present"})\n`
    : config.queue === "ship"
      ? `worker draining queues: ship (to ${config.sandbox.seed.url}, token ${config.sandbox.seed.auth === undefined ? "MISSING" : "present"})\n`
      : `worker draining queues: sandbox (image ${config.sandbox.image}, at most ${String(config.sandbox.concurrency)} at once)\n`);

// Tell the runs in flight to end NOW (as failed/worker_stopped: a row left `running` would block its
// document's next run until its heartbeat went stale, 15 s later), stop taking jobs, wait for those endings to be written, close the pool.
const shutdown = createShutdown({ steps: [() => { clearInterval(reaper); stopping.abort(); return worker.close(); }, () => sync.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
