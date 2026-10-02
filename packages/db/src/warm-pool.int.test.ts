import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./index.ts";
import { TEST_DATABASE_URL } from "./testing.ts";

// noon-cs6.3.2: on a slow Postgres a read that first had to open a connection (the pg handshake, several round trips)
// ran past the journal bound, the node said "try again", and the next open did the same. A warm pool keeps one open
// past the idle timeout (10 s); close() still ends it, or a shutdown would hang on it. Its own file: no other pool
// of this run is connected as noon-db meanwhile (integration files run one at a time).
let admin: Client;
beforeAll(async () => {
  admin = new Client({ connectionString: TEST_DATABASE_URL, application_name: "noon-test-admin" });
  await admin.connect();
});
afterAll(() => admin.end());
const connected = async (): Promise<number> =>
  ((await admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name = 'noon-db'")).rows[0]?.n ?? 0);

test("a warm pool keeps a connection open past the idle timeout, and close() ends it", async () => {
  const db = createDb({ connectionString: TEST_DATABASE_URL, warm: 1 });
  await db.ping();
  await new Promise((resolve) => setTimeout(resolve, 10_500));
  expect(await connected()).toBe(1);
  await db.close();
  for (const deadline = Date.now() + 2000; (await connected()) > 0 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await connected()).toBe(0);
}, 20_000);
