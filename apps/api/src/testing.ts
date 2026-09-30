import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll } from "vitest";
import type { JobRef } from "@noon/queue";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../../../packages/db/src/testing.ts";
import { devHeaderIdentity } from "./identity.ts";
import { startServer, type RunningServer } from "./server.ts";

/** A real api on a free port over a throwaway database schema, for one test file. */
/** Session settings for tests; the sync server's tests will share the secret to verify tokens. */
const syncUrl = "ws://sync.test:3001";
export const TEST_SESSIONS = { secret: "test-only-session-secret-0123456789abcdef", syncUrl, sync: { kind: "one", url: syncUrl } as const, ttlSeconds: 90 }; // not the production 60: a handler that hardcodes 60 fails

type Ctx = {
  readonly db: TestDb;
  readonly server: RunningServer;
  /** fetch against this server as the default test user (override with an x-dev-user header). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
};

/** The Gitea webhook secret every test server holds (E5.3a). */
export const TEST_WEBHOOK_SECRET = "test-only-webhook-secret-0123456789abcdef";

export function useTestServer({ enqueue = () => Promise.resolve(), accessChanged }: { enqueue?: (ref: JobRef) => Promise<void>; accessChanged?: (change: { orgId: string; userId: string }) => Promise<void> } = {}): Ctx {
  let db: TestDb | undefined;
  let server: RunningServer | undefined;
  beforeAll(async () => {
    db = await createTestDb();
    server = await startServer({ port: 0, db: db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, webhookSecret: TEST_WEBHOOK_SECRET, enqueue, ...(accessChanged ? { accessChanged } : {}) }); // runs are tested with a real queue in apps/worker
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });
  const ready = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error("useTestServer: used before beforeAll ran");
    return value;
  };
  return {
    get db() { return ready(db); },
    get server() { return ready(server); },
    fetch: (path, init = {}) =>
      fetch(`${ready(server).url}${path}`, { ...init, headers: { "x-dev-user": "tester@example.com", ...(init.headers as Record<string, string> | undefined) } }),
  };
}

/**
 * The REAL entry point (main.ts) in a REAL process, for one test file: `boot(env)` starts it in a clean environment
 * (nothing from the test runner, such as NODE_ENV=test, leaks in) plus `env`, and answers once /health does. The
 * process is killed after each test.
 */
export function useApiProcess(): (env: Record<string, string>) => Promise<{ url: string; stderr: () => string }> {
  const main = new URL("./main.ts", import.meta.url).pathname;
  let child: ChildProcess | undefined;
  afterEach(() => child?.kill("SIGKILL"));
  return async (env) => {
    const port = String(20000 + Math.floor(Math.random() * 20000));
    let stderr = "";
    child = spawn(process.execPath, [main], { env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: TEST_DATABASE_URL, PORT: port, SESSION_TOKEN_SECRET: "m".repeat(32), SYNC_PUBLIC_URL: "ws://localhost:3001", REDIS_URL: "redis://localhost:6380", ...env } });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${url}/health`)).ok) return { url, stderr: () => stderr };
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error(`api did not start: ${stderr}`);
  };
}
