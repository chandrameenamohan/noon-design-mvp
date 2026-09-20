import { afterAll, beforeAll } from "vitest";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { devHeaderIdentity } from "./identity.ts";
import { startServer, type RunningServer } from "./server.ts";

/** A real api on a free port over a throwaway database schema, for one test file. */
/** Session settings for tests; the sync server's tests will share the secret to verify tokens. */
export const TEST_SESSIONS = { secret: "test-only-session-secret-0123456789abcdef", syncUrl: "ws://sync.test:3001", ttlSeconds: 90 }; // not the production 60: a handler that hardcodes 60 fails

type Ctx = {
  readonly db: TestDb;
  readonly server: RunningServer;
  /** fetch against this server as the default test user (override with an x-dev-user header). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
};

export function useTestServer(): Ctx {
  let db: TestDb | undefined;
  let server: RunningServer | undefined;
  beforeAll(async () => {
    db = await createTestDb();
    server = await startServer({ port: 0, db: db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve() }); // runs are tested with a real queue in apps/worker
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
