import { readdir } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./index.ts";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "./testing.ts";

// Every test here reproduces a finding from the E1.2 review panel.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

test.each(["   ", "", "  ", "x".repeat(201)])(
  "a bad name (%j) is refused BEFORE the insert, so it can never poison later reads",
  async (name) => {
    const org = await t.createOrg("Poison-proof");
    const scope = t.db.forOrg(org.id);
    await expect(scope.createWorkspace({ name })).rejects.toThrow();
    expect(await scope.listWorkspaces()).toMatchObject({ items: [] }); // the list still works, and nothing was stored

    const ws = await scope.createWorkspace({ name: "ok" });
    await expect(scope.createDocument({ workspaceId: ws.id, title: name })).rejects.toThrow();
    expect(await scope.listDocuments(ws.id)).toMatchObject({ items: [] });
    await expect(t.createOrg(name)).rejects.toThrow();
  },
);

test("names are stored trimmed", async () => {
  const org = await t.createOrg("  Acme  ");
  expect(org.name).toBe("Acme");
});

test("the database itself refuses an untrimmed or blank name, even through raw SQL", async () => {
  await expect(t.rawQuery("insert into orgs (name) values ('   ')")).rejects.toMatchObject({ code: "23514" });
  await expect(t.rawQuery("insert into orgs (name) values (' padded ')")).rejects.toMatchObject({ code: "23514" });
});

test("an id that is not a UUID means 'not found', not a database error", async () => {
  const org = await t.createOrg("Ids");
  const scope = t.db.forOrg(org.id);
  expect(await scope.getWorkspace("nope")).toBeUndefined();
  expect(await scope.getDocument("nope")).toBeUndefined();
  expect(await scope.listDocuments("nope")).toMatchObject({ items: [] });
  expect(await scope.createDocument({ workspaceId: "nope", title: "t" })).toBeUndefined();

  const nowhere = t.db.forOrg("not-an-org");
  expect(await nowhere.listWorkspaces()).toMatchObject({ items: [] });
  expect(await nowhere.getWorkspace(org.id)).toBeUndefined();
  await expect(nowhere.createWorkspace({ name: "w" })).rejects.toThrow(/org/);
});

test.each(["public -c statement_timeout=4321", "a;drop schema public", "Has Space", ""])(
  "a schema option that is not a plain identifier (%j) is refused",
  (schema) => {
    expect(() => createDb({ connectionString: TEST_DATABASE_URL, schema })).toThrow(/schema/);
  },
);

test("two processes migrating a fresh database at the same moment both succeed", async () => {
  const allMigrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).sort();
  expect(allMigrations[0]).toBe("0001_init.sql");
  for (let round = 0; round < 5; round++) {
    const fresh = await createTestDb({ migrate: false });
    const other = createDb({ connectionString: TEST_DATABASE_URL, schema: fresh.schema });
    try {
      await Promise.all([fresh.db.migrate(), other.migrate()]);
      // every migration file on disk recorded exactly once: none skipped, none doubled by the race
      expect(await fresh.db.appliedMigrations()).toEqual(allMigrations);
    } finally {
      await other.close();
      await fresh.drop();
    }
  }
}, 30_000); // five rounds of create-schema + two concurrent migrators + drop: slow, not flaky

test("when Postgres kills an idle connection the process survives and the next query works", async () => {
  const org = await t.createOrg("Survivor");
  await t.rawQuery(
    "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'noon-db' and pid <> pg_backend_pid()",
  );
  await new Promise((r) => setTimeout(r, 200)); // let the pool notice; an unhandled 'error' would fail this test run
  expect(await t.db.forOrg(org.id).listWorkspaces()).toMatchObject({ items: [] });
});

// From the E3.1 review: the jobs migration's promises, proven against the DATABASE with raw SQL.
test("the database itself refuses a half-finished, mislabelled or cross-org job, and a second unfinished AI run on one document", async () => {
  const mine = await t.createOrg("Jobs");
  const theirs = await t.createOrg("Other");
  const ws = await t.db.forOrg(mine.id).createWorkspace({ name: "ws" });
  const doc = await t.db.forOrg(mine.id).createDocument({ workspaceId: ws.id, title: "doc" });
  if (!doc) throw new Error("unreachable");
  const insert = (columns: string, values: string, orgId = mine.id) =>
    t.rawQuery(`insert into jobs (org_id, document_id, queue, input${columns}) values ($1, $2, 'ai', '{"instruction":"x"}'${values})`, [orgId, doc.id]);

  await expect(insert("", "", theirs.id)).rejects.toMatchObject({ code: "23503" }); // another org's document
  await expect(t.rawQuery("insert into jobs (org_id, document_id, queue, input) values ($1, $2, 'mail', '{}')", [mine.id, doc.id])).rejects.toMatchObject({ code: "23514" });
  await expect(insert(", status", ", 'succeeded'")).rejects.toMatchObject({ code: "23514" }); // finished, but when?
  await expect(insert(", status, finished_at", ", 'failed', now()")).rejects.toMatchObject({ code: "23514" }); // failed, but why?
  await expect(insert(", status, finished_at, error", ", 'succeeded', now(), 'oops'")).rejects.toMatchObject({ code: "23514" });
  await expect(insert(", finished_at", ", now()")).rejects.toMatchObject({ code: "23514" }); // queued, yet finished
  for (const reason of ["Has Spaces", "x".repeat(65), "9starts_with_digit", "stack at /repo/x.ts:1"]) {
    await expect(t.rawQuery("insert into jobs (org_id, document_id, queue, input, status, finished_at, error) values ($1, $2, 'ai', '{}', 'failed', now(), $3)", [mine.id, doc.id, reason]), reason).rejects.toMatchObject({ code: "23514" });
  }

  await insert(", status, finished_at, error", ", 'failed', now(), 'token_missing'"); // finished runs do not count
  await insert("", "");
  await expect(insert("", "")).rejects.toMatchObject({ code: "23505" });
  await expect(insert(", status, started_at", ", 'running', now()")).rejects.toMatchObject({ code: "23505" });
  await t.rawQuery("insert into jobs (org_id, document_id, queue, input) values ($1, $2, 'git', '{}')", [mine.id, doc.id]); // other queues are not held up by an AI run
});
