import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

test("migrations create the five tables, and every tenant table carries org_id", async () => {
  const tables = await t.columnsByTable();
  expect(Object.keys(tables).sort()).toEqual(
    ["documents", "memberships", "orgs", "schema_migrations", "users", "workspaces"].sort(),
  );
  for (const tenantTable of ["memberships", "workspaces", "documents"]) {
    expect(tables[tenantTable], tenantTable).toContain("org_id");
  }
});

test("running migrations again changes nothing", async () => {
  const before = await t.db.appliedMigrations();
  await t.db.migrate();
  expect(await t.db.appliedMigrations()).toEqual(before);
});

test("a workspace created in org A is visible to A and invisible to B", async () => {
  const a = await t.db.createOrg({ name: "Acme" });
  const b = await t.db.createOrg({ name: "Globex" });
  const ws = await t.db.forOrg(a.id).createWorkspace({ name: "Design" });

  expect(await t.db.forOrg(a.id).listWorkspaces()).toEqual([ws]);
  expect(await t.db.forOrg(a.id).getWorkspace(ws.id)).toEqual(ws);
  expect(await t.db.forOrg(b.id).listWorkspaces()).toEqual([]);
  expect(await t.db.forOrg(b.id).getWorkspace(ws.id)).toBeUndefined();
});

test("org B cannot create a document inside org A's workspace", async () => {
  const a = await t.db.createOrg({ name: "A" });
  const b = await t.db.createOrg({ name: "B" });
  const wsA = await t.db.forOrg(a.id).createWorkspace({ name: "A-ws" });

  // Through the accessor: B's scope does not see A's workspace, so nothing is created.
  expect(await t.db.forOrg(b.id).createDocument({ workspaceId: wsA.id, title: "sneaky" })).toBeUndefined();
  expect(await t.db.forOrg(a.id).listDocuments(wsA.id)).toEqual([]);

  // Behind the accessor: even raw SQL cannot do it, because the database itself refuses.
  await expect(
    t.rawQuery("insert into documents (org_id, workspace_id, title) values ($1, $2, 'sneaky')", [b.id, wsA.id]),
  ).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
});

test("a document lives in its org and workspace", async () => {
  const a = await t.db.createOrg({ name: "A2" });
  const scope = t.db.forOrg(a.id);
  const ws = await scope.createWorkspace({ name: "ws" });
  const doc = await scope.createDocument({ workspaceId: ws.id, title: "Checkout" });
  if (!doc) throw new Error("the document should have been created");
  expect(doc).toMatchObject({ orgId: a.id, workspaceId: ws.id, title: "Checkout" });
  expect(await scope.listDocuments(ws.id)).toEqual([doc]);
  expect(await scope.getDocument(doc.id)).toEqual(doc);
});

test("a membership role outside owner|editor|viewer is refused by the database", async () => {
  const a = await t.db.createOrg({ name: "A3" });
  await expect(
    t.rawQuery(
      "with u as (insert into users (email, name) values ('x@example.com', 'X') returning id) " +
        "insert into memberships (org_id, user_id, role) select $1, id, 'admin' from u",
      [a.id],
    ),
  ).rejects.toMatchObject({ code: "23514" }); // check_violation
});
