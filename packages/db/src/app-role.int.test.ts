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
  const org = await asApp.createOrg({ name: "Via app role", ownerId: (await asApp.upsertUser({ email: "app@example.com", name: "App" })).id });
  const ws = await asApp.forOrg(org.id).createWorkspace({ name: "ws" });
  expect(await asApp.forOrg(org.id).listWorkspaces()).toMatchObject({ items: [ws] });
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
  await asApp.ping();
});

test("re-provisioning strips privileges and memberships a role picked up some other way", async () => {
  const dirty = `${role}_dirty`;
  await t.rawQuery(`create role ${dirty} login bypassrls replication createdb createrole noinherit connection limit 5 in role pg_read_server_files password 'x'`);
  try {
    await provisionAppRole({ ownerUrl: TEST_DATABASE_URL, schema: t.schema, role: dirty, password });
    expect(await t.rawQuery(`select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolinherit, rolconnlimit from pg_roles where rolname = '${dirty}'`)).toMatchObject({
      rows: [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false, rolinherit: true, rolconnlimit: -1 }],
    });
    expect(await t.rawQuery(`select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = '${dirty}'`)).toMatchObject({ rows: [{ n: 0 }] });
  } finally {
    await t.rawQuery(`drop owned by ${dirty}`);
    await t.rawQuery(`drop role ${dirty}`);
  }
});

test("the password is stored as a SCRAM verifier, and logging in with the cleartext still works", async () => {
  expect(await t.rawQuery(`select rolpassword like 'SCRAM-SHA-256$%' as scram from pg_authid where rolname = '${role}'`)).toMatchObject({ rows: [{ scram: true }] });
  expect(await asAppRaw("select 1 as ok")).toMatchObject({ rows: [{ ok: 1 }] });
});

test("the app role cannot create temp tables or connect to other databases", async () => {
  await expect(asAppRaw("create temp table scratch (x int)")).rejects.toMatchObject({ code: "42501" });
  const u = new URL(appUrl);
  u.pathname = "/postgres";
  const other = new Client({ connectionString: u.toString() });
  await expect(other.connect()).rejects.toMatchObject({ code: "42501" });
});

test.each(["bad role", "x;drop", ""])("a role name that is not a plain identifier (%j) is refused", async (bad) => {
  await expect(provisionAppRole({ ownerUrl: TEST_DATABASE_URL, schema: t.schema, role: bad, password })).rejects.toThrow(/role/);
});
