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
  for (let round = 0; round < 5; round++) {
    const fresh = await createTestDb({ migrate: false });
    const other = createDb({ connectionString: TEST_DATABASE_URL, schema: fresh.schema });
    try {
      await Promise.all([fresh.db.migrate(), other.migrate()]);
      expect(await fresh.db.appliedMigrations()).toEqual(["0001_init.sql", "0002_memberships_user_id.sql"]);
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
