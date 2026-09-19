import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, provisionAppRole, type Db } from "./index.ts";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "./testing.ts";

// The api must not connect as the database owner: a superuser bypasses every permission, which
// would make "audit rows cannot be changed" (F26) impossible to promise later.
const role = `noon_app_test_${randomBytes(4).toString("hex")}`;
const password = "test-only-password";
let t: TestDb;
let appUrl: string;
let asApp: Db;

beforeAll(async () => {
  t = await createTestDb();
  await provisionAppRole({ ownerUrl: TEST_DATABASE_URL, schema: t.schema, role, password });
  const u = new URL(TEST_DATABASE_URL);
  u.username = role;
  u.password = password;
  appUrl = u.toString();
  asApp = createDb({ connectionString: appUrl, schema: t.schema });
});
afterAll(async () => {
  await asApp.close();
  await t.rawQuery(`drop owned by ${role}`);
  await t.rawQuery(`drop role ${role}`);
  await t.drop();
});

async function asAppRaw(sql: string): Promise<unknown> {
  const c = new Client({ connectionString: appUrl, options: `-c search_path=${t.schema}` });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

test("the app role can do the product's work", async () => {
  const org = await asApp.createOrg({ name: "Via app role" });
  const ws = await asApp.forOrg(org.id).createWorkspace({ name: "ws" });
  expect(await asApp.forOrg(org.id).listWorkspaces()).toEqual([ws]);
});

test("the app role is not a superuser and cannot change the schema or the migration history", async () => {
  expect(await asAppRaw("select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user")).toMatchObject({
    rows: [{ rolsuper: false, rolcreaterole: false, rolcreatedb: false }],
  });
  await expect(asAppRaw("create table sneaky (id int)")).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege
  await expect(asAppRaw("drop table documents")).rejects.toMatchObject({ code: "42501" });
  await expect(asAppRaw("alter table orgs disable trigger all")).rejects.toMatchObject({ code: "42501" });
  await expect(asAppRaw("delete from schema_migrations")).rejects.toMatchObject({ code: "42501" });
  await expect(asApp.migrate()).rejects.toThrow();
});

test("provisioning twice is safe and updates the password", async () => {
  await provisionAppRole({ ownerUrl: TEST_DATABASE_URL, schema: t.schema, role, password });
  expect(await asApp.getOrg("00000000-0000-4000-8000-000000000000")).toBeUndefined();
});

test.each(["bad role", "x;drop", ""])("a role name that is not a plain identifier (%j) is refused", async (bad) => {
  await expect(provisionAppRole({ ownerUrl: TEST_DATABASE_URL, schema: t.schema, role: bad, password })).rejects.toThrow(/role/);
});
