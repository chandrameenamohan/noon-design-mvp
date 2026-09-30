import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";

// E9.5 (F31): the usage report sums an org's runs per user and per UTC day, beside one page of the runs (newest first,
// each naming who ran it), all from one snapshot; and `take`, the limiter E9.6 reuses, counts in the database.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const amount = (inputTokens: number, costUsd: number) => ({ model: "claude-test-1", inputTokens, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
const idOf = async (sql: string, params: unknown[]): Promise<string> => ((await t.rawQuery(sql, params)) as { rows: { id: string }[] }).rows[0]?.id ?? "";

test("per run (who ran it), per user (most expensive first) and per UTC day (newest first), adding up to the totals", async () => {
  const doc = await t.createDocument("Spenders");
  const ann = await idOf("insert into users (email, name) values ('usage-ann@example.com', 'Ann') returning id", []);
  const bob = await idOf("insert into users (email, name) values ('usage-bob@example.com', 'Bob') returning id", []);
  await t.rawQuery("insert into memberships (org_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'editor')", [doc.orgId, ann, bob]);
  const spend = async (user: string, inputTokens: number, costUsd: number, daysAgo: number): Promise<string> => {
    const run = await t.db.forOrg(doc.orgId).createRun({ documentId: doc.id, instruction: "spend", createdBy: user });
    if (typeof run !== "object" || !("id" in run)) throw new Error(`no run: ${JSON.stringify(run)}`);
    const key = { queue: "ai" as const, jobId: run.id, orgId: doc.orgId };
    await t.db.jobStore().claim(key);
    await t.db.jobStore().recordUsage(key, amount(inputTokens, costUsd));
    await t.db.jobStore().finish(key, "succeeded");
    await t.rawQuery("update usage set created_at = now() - make_interval(days => $2) where job_id = $1", [run.id, daysAgo]);
    return run.id;
  };
  const oldest = await spend(ann, 100, 0.01, 1);
  await spend(bob, 200, 0.5, 0);
  const newest = await spend(ann, 300, 0.02, 0);

  const report = await t.db.forOrg(doc.orgId).usage();
  expect(report?.totals).toEqual({ runs: 3, inputTokens: 600, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.53 });
  expect(report?.byUser.map((u) => [u.email, u.runs, u.inputTokens, u.costUsd])).toEqual([["usage-bob@example.com", 1, 200, 0.5], ["usage-ann@example.com", 2, 400, 0.03]]);
  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  expect(report?.byDay.map((d) => [d.day, d.runs, d.inputTokens])).toEqual([[day(0), 2, 500], [day(1), 1, 100]]);
  expect(report?.items.map((i) => i.runId)).toEqual([newest, expect.any(String), oldest]);
  expect(report?.items[0]).toMatchObject({ userId: ann, email: "usage-ann@example.com", inputTokens: 300, costUsd: 0.02 });

  // A deleted user's runs keep their cost, and name no one.
  await t.rawQuery("delete from users where id = $1", [bob]);
  const after = await t.db.forOrg(doc.orgId).usage();
  expect(after?.totals.costUsd).toBe(0.53);
  expect(after?.byUser.find((u) => u.userId === null)).toMatchObject({ email: null, runs: 1, costUsd: 0.5 });
});

test("another org's report is empty in every part", async () => {
  const other = await t.createOrg("Nothing spent");
  expect(await t.db.forOrg(other.id).usage()).toEqual({ totals: { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, byUser: [], byDay: [], items: [], nextCursor: null });
});

test("take: twenty hits at once on one key, limit five: exactly five go ahead, and the rest are told the same window end", async () => {
  const rule = { limit: 5, windowSeconds: 3600 };
  const key = `test:${crypto.randomUUID()}`;
  const verdicts = await Promise.all(Array.from({ length: 20 }, () => t.db.take(key, rule)));
  expect(verdicts.filter((v) => v.ok)).toHaveLength(5);
  const waits = new Set(verdicts.flatMap((v) => (v.ok ? [] : [v.retryAfterSeconds])));
  expect(Math.max(...waits) - Math.min(...waits)).toBeLessThanOrEqual(1);
  expect(Math.max(...waits)).toBeLessThanOrEqual(3600);
  expect(await t.db.take(`test:${crypto.randomUUID()}`, rule)).toEqual({ ok: true }); // another key, its own count
});
