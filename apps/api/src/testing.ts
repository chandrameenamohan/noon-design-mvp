import { afterAll, beforeAll } from "vitest";
import type { JobRef } from "@noon/queue";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
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
