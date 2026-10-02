import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./index.ts";
import { TEST_DATABASE_URL } from "./testing.ts";

// noon-cs6.3.2: on a slow Postgres a read that first had to open a connection (the pg handshake, several round trips)
// ran past the journal bound, the node said "try again", and the next open did the same. A warm pool keeps one open
// past the idle timeout (10 s); close() still ends it, or a shutdown would hang on it. Its pool connects under a name
// of its own (the connection string's application_name wins over createDb's): other pools on this Postgres, a parallel
// run's included, are not counted.
let admin: Client;
beforeAll(async () => {
  admin = new Client({ connectionString: TEST_DATABASE_URL, application_name: "noon-test-admin" });
  await admin.connect();
});
afterAll(() => admin.end());
const name = `noon-warm-${randomBytes(6).toString("hex")}`;
const url = new URL(TEST_DATABASE_URL);
url.searchParams.set("application_name", name);
const connected = async (): Promise<number> =>
  ((await admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name = $1", [name])).rows[0]?.n ?? 0);

test("a warm pool keeps a connection open past the idle timeout, and close() ends it", async () => {
  const db = createDb({ connectionString: url.href, warm: 1 });
  await db.ping();
  await new Promise((resolve) => setTimeout(resolve, 10_500));
  expect(await connected()).toBe(1);
  await db.close();
  for (const deadline = Date.now() + 2000; (await connected()) > 0 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await connected()).toBe(0);
}, 20_000);
