import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The e2e layer runs the api and the sync server FROM SOURCE, on ports of its own: the Docker
// containers hold whatever was built last, and a gate that tests yesterday's code proves nothing.
// Only Postgres is shared with the dev stack (./init.sh starts it). The secrets come from .env,
// read by the shell (`. ./.env`) so that they never pass through this file or a log.
// sandboxProxy: never the dev stack's (20000); the canvas's dev server forwards /preview/ there.
const PORTS = { web: 5174, api: 3100, sync: 3101, worker: 3102, sandboxProxy: 20100 };
const DOCKER_BIN = "/Applications/Docker.app/Contents/Resources/bin";
const fromEnv = (command: string): string =>
  `sh -c 'set -a; . ./.env; set +a; export NODE_ENV=development DATABASE_URL="postgres://noon_app:$APP_DB_PASSWORD@localhost:\${PG_PORT:-5432}/noon" REDIS_URL="redis://:$REDIS_PASSWORD@localhost:\${REDIS_PORT:-6380}"; ${command}'`;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: true,
  globalSetup: "./e2e/setup.ts",
  globalTeardown: "./e2e/teardown.ts",
  use: { baseURL: `http://localhost:${String(PORTS.web)}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    // Hosted as through a tunnel (noon-l96): the preview rides the canvas's own origin, as /preview/.
    // The loopback address the canvas frames otherwise is what the sandbox and worker suites load.
    { command: fromEnv(`PORT=${String(PORTS.api)} SYNC_PUBLIC_URL=ws://localhost:${String(PORTS.sync)} PREVIEW_PUBLIC_URL=http://localhost:${String(PORTS.web)} node apps/api/src/main.ts`), url: `http://localhost:${String(PORTS.api)}/ready`, reuseExistingServer: false },
    { command: fromEnv(`PORT=${String(PORTS.sync)} SYNC_NODE_ID=e2e node apps/sync/src/main.ts`), url: `http://localhost:${String(PORTS.sync)}/health`, reuseExistingServer: false },
    // The scripted worker has no port of its own; it answers on one only to tell Playwright it is up.
    { command: fromEnv(`SYNC_URL=ws://localhost:${String(PORTS.sync)} READY_PORT=${String(PORTS.worker)} node e2e/stub-worker.ts`), url: `http://localhost:${String(PORTS.worker)}`, reuseExistingServer: false },
    // The REAL sandbox worker, from source, in a pool of its own: its reaper never touches the dev
    // stack's sandboxes, nor theirs its. It prints this line once it is draining its queue.
    { command: fromEnv(`PATH="$PATH:${DOCKER_BIN}" WORKER_QUEUE=sandbox SEED_REPO=http://127.0.0.1:\${GITEA_PORT:-3002}/noon/sample-app.git SANDBOX_POOL=noon-e2e SANDBOX_PROXY_PORT=${String(PORTS.sandboxProxy)} DOCKER=${DOCKER_BIN}/docker SYNC_URL=ws://localhost:${String(PORTS.sync)} node apps/worker/src/main.ts`), wait: { stdout: /worker draining queues: sandbox/u }, reuseExistingServer: false },
    // The REAL git peer (E5.3b), from source, against the dev stack's Gitea, with a mirror of its own. setup.ts
    // stops the compose one: both would drain the same inbox, and that one would edit through the compose sync.
    { command: fromEnv(`WORKER_QUEUE=git SEED_REPO=http://127.0.0.1:\${GITEA_PORT:-3002}/noon/sample-app.git GIT_PEER_DIR=${join(tmpdir(), "noon-e2e-git")} SYNC_URL=ws://localhost:${String(PORTS.sync)} node apps/worker/src/main.ts`), wait: { stdout: /git peer watching/u }, reuseExistingServer: false },
    // The REAL ship worker (E5.5), from source, against the dev stack's Gitea; setup.ts stops the compose one.
    { command: fromEnv(`WORKER_QUEUE=ship SEED_REPO=http://127.0.0.1:\${GITEA_PORT:-3002}/noon/sample-app.git SYNC_URL=ws://localhost:${String(PORTS.sync)} node apps/worker/src/main.ts`), wait: { stdout: /worker draining queues: ship/u }, reuseExistingServer: false },
    { command: `PUBLIC_HOST=localhost SANDBOX_PROXY_URL=http://127.0.0.1:${String(PORTS.sandboxProxy)} API_TARGET=http://localhost:${String(PORTS.api)} pnpm --filter @noon/web exec vite --port ${String(PORTS.web)} --strictPort`, url: `http://localhost:${String(PORTS.web)}`, reuseExistingServer: false },
  ],
});
