import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The e2e layer runs the api and the sync server FROM SOURCE, on ports of its own: the Docker
// containers hold whatever was built last, and a gate that tests yesterday's code proves nothing.
// Only Postgres is shared with the dev stack (./init.sh starts it). The secrets come from .env,
// read by the shell (`. ./.env`) so that they never pass through this file or a log.
// sandboxProxy: never the dev stack's (20000); the canvas's dev server forwards /preview/ there.
const PORTS = { web: 5174, api: 3100, sync: 3101, worker: 3102, sync2: 3104, sandboxProxy: 20100 };
const DOCKER_BIN = "/Applications/Docker.app/Contents/Resources/bin";
const fromEnv = (command: string): string =>
  `sh -c 'set -a; . ./.env; set +a; export NODE_ENV=development DATABASE_URL="postgres://noon_app:$APP_DB_PASSWORD@localhost:\${PG_PORT:-5432}/noon" REDIS_URL="redis://:$REDIS_PASSWORD@localhost:\${REDIS_PORT:-6380}"; ${command}'`;

const chrome = { ...devices["Desktop Chrome"] };
/**
 * The specs that assert a DURATION: canvas.spec's 200 ms p95 from an edit to the other browser's DOM, and
 * progress.spec's run of one step every 400 ms, reloaded while it is still running. They run in a project of their
 * own that depends on the main one, so it starts when that has ended, and on one worker: nothing else of this suite
 * is running while they measure. noon-ibo: beside four other workers' browsers, AI runs and sandbox containers (host
 * load 28-40) the same edits measured p95 226-328 ms, and most of each was the page waiting for a CPU before the op
 * had even left it (median 57-76 ms, up to 383), which is the test's neighbours, not the product. The limits are
 * unchanged. A project-level testIgnore replaces the config's, hence the scenario named again below.
 * One file at a time: `pnpm exec playwright test e2e/canvas.spec.ts --no-deps` (without it the main project runs
 * first, whole). ponytail: if the main project fails, Playwright skips this one; the gate is red either way.
 */
const TIMED = ["**/canvas.spec.ts", "**/progress.spec.ts"];

/**
 * The e2e layer on one sync node, or on two (`e2e` and `e2e-2`, routed by their leases in Redis as compose's `sync` and
 * `sync-2` are). The SPEC §8 scenario runs on two and `kill -9`s one of them, so it has a run of its own
 * (playwright.scenario.config.ts): a node dying under the other specs' rooms is not what they test.
 */
export function e2eConfig({ twoSyncNodes }: { twoSyncNodes: boolean }) {
  const sync = `ws://localhost:${String(PORTS.sync)}`;
  // What the api hands browsers and what the workers dial: one URL, or the id=url routing table (packages/lease).
  const syncNodes = twoSyncNodes ? `e2e=${sync},e2e-2=ws://localhost:${String(PORTS.sync2)}` : sync;
  const syncServer = (port: number, nodeId: string) =>
    ({ command: fromEnv(`PORT=${String(port)} SYNC_NODE_ID=${nodeId} MINIO_URL=http://localhost:\${MINIO_PORT:-9005} MINIO_USER=noon node apps/sync/src/main.ts`), url: `http://localhost:${String(port)}/health`, reuseExistingServer: false });
  return defineConfig({
    testDir: "e2e",
    // The scenario runs alone, on two nodes (playwright.scenario.config.ts); every other spec runs on one.
    ...(twoSyncNodes ? { testMatch: "spec-scenario.spec.ts" } : { testIgnore: "spec-scenario.spec.ts" }),
    forbidOnly: true,
    globalSetup: "./e2e/setup.ts",
    globalTeardown: "./e2e/teardown.ts",
    use: { baseURL: `http://localhost:${String(PORTS.web)}` },
    projects: twoSyncNodes ? [{ name: "chromium", use: chrome }] : [
      { name: "chromium", use: chrome, testIgnore: ["spec-scenario.spec.ts", ...TIMED] },
      { name: "timed", use: chrome, testMatch: TIMED, dependencies: ["chromium"], workers: 1 },
    ],
    webServer: [
      // Hosted as through a tunnel (noon-l96): the preview rides the canvas's own origin, as /preview/.
      // The loopback address the canvas frames otherwise is what the sandbox and worker suites load.
      { command: fromEnv(`PORT=${String(PORTS.api)} SYNC_PUBLIC_URL=${syncNodes} PREVIEW_PUBLIC_URL=http://localhost:${String(PORTS.web)} node apps/api/src/main.ts`), url: `http://localhost:${String(PORTS.api)}/ready`, reuseExistingServer: false },
      // Snapshots (E6.2) go to the dev stack's MinIO and its bucket: the documents' snapshot_seq lives in the shared
      // Postgres, so a bucket of its own would miss the objects the compose sync wrote. Only the password is a secret.
      syncServer(PORTS.sync, "e2e"),
      ...(twoSyncNodes ? [syncServer(PORTS.sync2, "e2e-2")] : []),
      // The scripted worker has no port of its own; it answers on one only to tell Playwright it is up.
      { command: fromEnv(`SYNC_URL=${syncNodes} READY_PORT=${String(PORTS.worker)} node e2e/stub-worker.ts`), url: `http://localhost:${String(PORTS.worker)}`, reuseExistingServer: false },
      // The REAL sandbox worker, from source, in a pool of its own: its reaper never touches the dev
      // stack's sandboxes, nor theirs its. It prints this line once it is draining its queue.
      { command: fromEnv(`PATH="$PATH:${DOCKER_BIN}" WORKER_QUEUE=sandbox SEED_REPO=http://127.0.0.1:\${GITEA_PORT:-3002}/noon/sample-app.git SANDBOX_POOL=noon-e2e SANDBOX_PROXY_PORT=${String(PORTS.sandboxProxy)} DOCKER=${DOCKER_BIN}/docker SYNC_URL=${syncNodes} node apps/worker/src/main.ts`), wait: { stdout: /worker draining queues: sandbox/u }, reuseExistingServer: false },
      // The REAL git peer (E5.3b), from source, against the dev stack's Gitea, with a mirror of its own. setup.ts
      // stops the compose one: both would drain the same inbox, and that one would edit through the compose sync.
      { command: fromEnv(`WORKER_QUEUE=git SEED_REPO=http://127.0.0.1:\${GITEA_PORT:-3002}/noon/sample-app.git GIT_PEER_DIR=${join(tmpdir(), "noon-e2e-git")} SYNC_URL=${syncNodes} node apps/worker/src/main.ts`), wait: { stdout: /git peer watching/u }, reuseExistingServer: false },
      // The REAL ship worker (E5.5), from source, against the dev stack's Gitea; setup.ts stops the compose one.
      { command: fromEnv(`WORKER_QUEUE=ship SEED_REPO=http://127.0.0.1:\${GITEA_PORT:-3002}/noon/sample-app.git SYNC_URL=${syncNodes} node apps/worker/src/main.ts`), wait: { stdout: /worker draining queues: ship/u }, reuseExistingServer: false },
      { command: `PUBLIC_HOST=localhost SANDBOX_PROXY_URL=http://127.0.0.1:${String(PORTS.sandboxProxy)} API_TARGET=http://localhost:${String(PORTS.api)} pnpm --filter @noon/web exec vite --port ${String(PORTS.web)} --strictPort`, url: `http://localhost:${String(PORTS.web)}`, reuseExistingServer: false },
    ],
  });
}

export default e2eConfig({ twoSyncNodes: false });
