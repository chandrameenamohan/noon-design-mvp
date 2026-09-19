import { afterAll, beforeAll } from "vitest";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { devHeaderIdentity } from "./identity.ts";
import { startServer, type RunningServer } from "./server.ts";

/** A real api on a free port over a throwaway database schema, for one test file. */
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
    server = await startServer({ port: 0, db: db.db, identify: devHeaderIdentity });
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
