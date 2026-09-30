import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createAppRole, createTestDb, type AppRole, type TestDb } from "./testing.ts";

// integration:audit-immutable-db-role (E8.4, F26). The app's login role, provisioned exactly as migrate-cli does it,
// may add to the audit trail and read it, and the DATABASE refuses it every way of changing or removing a row. The
// table's trigger refuses the owner too, and deleting an org or a user (cascades included) leaves the trail as it was.
let t: TestDb;
let app: AppRole;
beforeAll(async () => {
  t = await createTestDb();
  app = await createAppRole(t);
});
afterAll(async () => {
  await app.drop();
  await t.drop();
});

type Row = { id: string; org_id: string; actor_id: string | null; actor_email: string | null; action: string; detail: unknown; created_at: Date };
const trail = async (orgId: string): Promise<Row[]> =>
  ((await t.rawQuery("select * from audit_log where org_id = $1 order by created_at, id", [orgId])) as { rows: Row[] }).rows;

/** An org with an owner and an editor, whose role change the app role writes (through the product's own method). */
async function audited(tag: string) {
  const owner = await app.db.upsertUser({ email: `${tag}-owner@example.com`, name: "Owner" });
  const editor = await app.db.upsertUser({ email: `${tag}-editor@example.com`, name: "Editor" });
  const org = await app.db.createOrg({ name: tag, ownerId: owner.id });
  expect(await app.db.forOrg(org.id).setMember({ email: editor.email, role: "editor", by: owner.id })).toMatchObject({ role: "editor" });
  const rows = await trail(org.id);
  expect(rows).toMatchObject([{ action: "role_changed", actor_id: owner.id, actor_email: owner.email }]);
  return { owner, editor, org, rows };
}

describe("integration:audit-immutable-db-role", () => {
  test("the app role holds SELECT and INSERT on audit_log, and neither UPDATE, DELETE nor TRUNCATE", async () => {
    const privileges = await t.rawQuery(
      "select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i, has_table_privilege($1, $2, 'update') as u, " +
        "has_table_privilege($1, $2, 'delete') as d, has_table_privilege($1, $2, 'truncate') as t",
      [app.role, `${t.schema}.audit_log`],
    );
    expect(privileges).toMatchObject({ rows: [{ s: true, i: true, u: false, d: false, t: false }] });
  });

  test("as the app role, every UPDATE, DELETE and TRUNCATE of audit rows is refused by Postgres (42501), and the rows are unchanged", async () => {
    const { org, rows } = await audited("immutable-app");
    for (const sql of [
      "update audit_log set action = 'signed_in' where org_id = $1",
      "update audit_log set actor_email = 'someone-else@example.com'",
      "delete from audit_log where org_id = $1",
      "delete from audit_log",
    ]) {
      await expect(app.raw(sql, sql.includes("$1") ? [org.id] : []), sql).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege
    }
    await expect(app.raw("truncate audit_log")).rejects.toMatchObject({ code: "42501" });
    // Nor by the back doors a table owner would have: the app role owns nothing.
    await expect(app.raw("alter table audit_log disable trigger audit_log_no_change")).rejects.toMatchObject({ code: "42501" });
    await expect(app.raw("drop table audit_log")).rejects.toMatchObject({ code: "42501" });
    expect(await trail(org.id)).toEqual(rows);
  });

  test("re-provisioning takes UPDATE and DELETE away again, if someone granted them by hand", async () => {
    await t.rawQuery(`grant update, delete on ${t.schema}.audit_log to ${app.role}`);
    await app.reprovision();
    expect(await t.rawQuery("select has_table_privilege($1, $2, 'update') as u, has_table_privilege($1, $2, 'delete') as d", [app.role, `${t.schema}.audit_log`]))
      .toMatchObject({ rows: [{ u: false, d: false }] });
  });

  test("the trigger refuses the owner too: a row cannot be changed or removed by anyone who connects", async () => {
    const { org, rows } = await audited("immutable-owner");
    await expect(t.rawQuery("update audit_log set action = 'signed_in' where org_id = $1", [org.id])).rejects.toThrow(/append-only/);
    await expect(t.rawQuery("delete from audit_log where org_id = $1", [org.id])).rejects.toThrow(/append-only/);
    await expect(t.rawQuery("truncate audit_log")).rejects.toThrow(/append-only/);
    expect(await trail(org.id)).toEqual(rows);
  });

  test("deleting the org, or the user who acted, erases nothing: no cascade, no set null (the E1.2 review)", async () => {
    const { owner, editor, org, rows } = await audited("immutable-cascade");
    await t.rawQuery("delete from orgs where id = $1", [org.id]);
    await t.rawQuery("delete from users where id = any($1)", [[owner.id, editor.id]]);
    expect(await trail(org.id)).toEqual(rows); // the actor's id and email as they were
  });

  test("a failed action leaves no audit row: the row and the action commit or roll back together", async () => {
    const { org, owner } = await audited("immutable-atomic");
    // The last owner cannot step down: refused inside the transaction, so nothing is recorded.
    expect(await app.db.forOrg(org.id).setMember({ email: owner.email, role: "viewer", by: owner.id })).toBe("last_owner");
    const ws = await app.db.forOrg(org.id).createWorkspace({ name: "ws" });
    const doc = await app.db.forOrg(org.id).createDocument({ workspaceId: ws.id, title: "d" });
    if (!doc) throw new Error("no document");
    expect(await app.db.forOrg(org.id).createRun({ documentId: doc.id, instruction: "first", createdBy: owner.id })).toMatchObject({ status: "queued" });
    expect(await app.db.forOrg(org.id).createRun({ documentId: doc.id, instruction: "second", createdBy: owner.id })).toBe("busy"); // the statement failed
    expect((await trail(org.id)).map((r) => [r.action, (r.detail as { instruction?: string }).instruction])).toEqual([["role_changed", undefined], ["run_started", "first"]]);
  });
});
