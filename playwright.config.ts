import { defineConfig, devices } from "@playwright/test";

// The e2e layer runs the api and the sync server FROM SOURCE, on ports of its own: the Docker
// containers hold whatever was built last, and a gate that tests yesterday's code proves nothing.
// Only Postgres is shared with the dev stack (./init.sh starts it). The secrets come from .env,
// read by the shell (`. ./.env`) so that they never pass through this file or a log.
const PORTS = { web: 5174, api: 3100, sync: 3101 };
const fromEnv = (command: string): string =>
  `sh -c 'set -a; . ./.env; set +a; export NODE_ENV=development DATABASE_URL="postgres://noon_app:$APP_DB_PASSWORD@localhost:\${PG_PORT:-5432}/noon"; ${command}'`;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: true,
  globalTeardown: "./e2e/teardown.ts",
  use: { baseURL: `http://localhost:${String(PORTS.web)}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: fromEnv(`PORT=${String(PORTS.api)} SYNC_PUBLIC_URL=ws://localhost:${String(PORTS.sync)} node apps/api/src/main.ts`), url: `http://localhost:${String(PORTS.api)}/ready`, reuseExistingServer: false },
    { command: fromEnv(`PORT=${String(PORTS.sync)} node apps/sync/src/main.ts`), url: `http://localhost:${String(PORTS.sync)}/health`, reuseExistingServer: false },
    { command: `API_TARGET=http://localhost:${String(PORTS.api)} pnpm --filter @noon/web exec vite --port ${String(PORTS.web)} --strictPort`, url: `http://localhost:${String(PORTS.web)}`, reuseExistingServer: false },
  ],
});
