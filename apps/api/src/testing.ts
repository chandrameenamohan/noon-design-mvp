import { afterAll, beforeAll } from "vitest";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { startServer, type RunningServer } from "./server.ts";

/** A real api on a free port over a throwaway database schema, for one test file. */
export function useTestServer(): { readonly db: TestDb; readonly server: RunningServer } {
  let db: TestDb | undefined;
  let server: RunningServer | undefined;
  beforeAll(async () => {
    db = await createTestDb();
    server = await startServer({ port: 0, db: db.db });
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
  };
}
