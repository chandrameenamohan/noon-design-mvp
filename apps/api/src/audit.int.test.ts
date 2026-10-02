import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { AuditPage, Document, ErrorBody, Member, Org, Run, Ship, User, Workspace, type AuditEntry } from "@noon/contracts";
import { useTestServer } from "./testing.ts";

// integration:audit-written-all-event-types (E8.4, F26). Every kind of event the audit view lists, each made the way
// the product makes it (the api's routes; a rejected push through the git store the worker's git peer calls), then
// read back through GET /orgs/:orgId/audit: who, what and when, newest first, for owners only. Refused actions leave
// nothing behind, and no route changes or removes an entry.
const ctx = useTestServer();
const tag = randomUUID().slice(0, 8);
const who = { owner: `audit-owner-${tag}@example.com`, editor: `audit-editor-${tag}@example.com`, outsider: `audit-outsider-${tag}@example.com`, stranger: `audit-stranger-${tag}@example.com` };
type Who = keyof typeof who;
const password = "correct horse battery";

/** `as` null: no one in particular (the sign-in routes are public, and read no identity). */
async function call(as: Who | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await ctx.fetch(path, {
    method,
    headers: { ...(as === null ? {} : { "x-dev-user": who[as] }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: res.status === 204 ? null : await res.json() };
}
async function readAll(orgId: string, limit = 50): Promise<AuditEntry[]> {
  const all: AuditEntry[] = [];
  let cursor: string | null = null;
  do {
    const res = await call("owner", "GET", `/orgs/${orgId}/audit?limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(res.status).toBe(200);
    const page = AuditPage.parse(res.json);
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return all;
}

describe("integration:audit-written-all-event-types", () => {
  test("sign-ins, role and share changes, AI runs, ships and rejected pushes are listed with who, what and when", async () => {
    const started = Date.now();
    // The owner signs up with a password (no org yet: nothing to audit), then works through the header as that same user.
    const owner = User.parse((await call(null, "POST", "/auth/signup", { email: who.owner, name: "Owner", password })).json);
    for (const each of ["editor", "outsider", "stranger"] as const) expect((await call(each, "GET", "/orgs")).status).toBe(200); // the header creates them
    const org = Org.parse((await call("owner", "POST", "/orgs", { name: "Audited" })).json);
    const ws = Workspace.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces`, { name: "ws" })).json);
    const doc = Document.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "doc" })).json);

    expect((await call(null, "POST", "/auth/signin", { email: who.owner, password })).status).toBe(200); // 1. signed_in
    expect((await call(null, "POST", "/auth/signin", { email: who.owner, password: "wrong horse battery" })).status).toBe(401); // not a sign-in
    const editor = Member.parse((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.editor, role: "editor" })).json); // 2. role_changed
    expect((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.editor, role: "editor" })).status).toBe(200); // the same role: no change, no row
    expect((await call("editor", "PUT", `/orgs/${org.id}/members`, { email: who.editor, role: "owner" })).status).toBe(403); // refused: no row
    expect((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.editor, role: "viewer" })).status).toBe(200); // 3. role_changed
    const shared = Member.parse((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.outsider, role: "editor" })).json); // 4. share_granted
    expect((await call("owner", "DELETE", `/documents/${doc.id}/shares/${shared.userId}`)).status).toBe(204); // 5. share_revoked
    expect((await call("owner", "DELETE", `/documents/${doc.id}/shares/${shared.userId}`)).status).toBe(404); // nothing to revoke: no row
    // What a person typed is kept exactly, markup and all: the view renders it as text.
    const instruction = `<img src=x onerror="alert(1)"> add a pricing card ${tag}`;
    const run = Run.parse((await call("owner", "POST", `/documents/${doc.id}/runs`, { instruction })).json); // 6. run_started
    expect((await call("owner", "POST", `/documents/${doc.id}/runs`, { instruction: "a second" })).status).toBe(409); // busy: no row
    const ship = Ship.parse((await call("owner", "POST", `/documents/${doc.id}/ship`)).json); // 7. ship_started
    expect((await call("owner", "POST", `/documents/${doc.id}/ship`)).status).toBe(200); // joins the waiting ship: no row
    // 8. push_rejected: the worker's git peer refused a push to the document's branch (apps/worker/src/push.ts keepConflict).
    const commit = "c".repeat(40);
    await ctx.db.db.gitStore().recordConflict(doc.id, { commit, file: `src/pages/noon-${doc.id}.tsx`, reason: "spread", detail: "line 3" });
    // noon-dtf.4.1: the same commit refused again (its git event resumed: the peer died before finishing it). No second row.
    await ctx.db.db.gitStore().recordConflict(doc.id, { commit, file: `src/pages/noon-${doc.id}.tsx`, reason: "spread", detail: "line 3" });

    const entries = await readAll(org.id); // newest first: reversed, they are the order things happened in
    const byUser = { kind: "user", id: owner.id, email: who.owner };
    expect([...entries].reverse().map(({ actor, action, documentId, detail }) => ({ actor, action, documentId, detail }))).toEqual([
      { actor: byUser, action: "signed_in", documentId: null, detail: {} },
      { actor: byUser, action: "role_changed", documentId: null, detail: { email: who.editor, role: "editor", previous: "none" } },
      { actor: byUser, action: "role_changed", documentId: null, detail: { email: who.editor, role: "viewer", previous: "editor" } },
      { actor: byUser, action: "share_granted", documentId: doc.id, detail: { email: who.outsider, role: "editor" } },
      { actor: byUser, action: "share_revoked", documentId: doc.id, detail: { email: who.outsider } },
      { actor: byUser, action: "run_started", documentId: doc.id, detail: { run: run.id, instruction } },
      { actor: byUser, action: "ship_started", documentId: doc.id, detail: { ship: ship.id } },
      { actor: { kind: "git", id: null, email: null }, action: "push_rejected", documentId: doc.id, detail: { commit, file: `src/pages/noon-${doc.id}.tsx`, reason: "spread" } },
    ]);
    for (const entry of entries) {
      expect(entry.orgId).toBe(org.id);
      expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(started - 5000); // when: the server's clock, near now
      expect(Date.parse(entry.at)).toBeLessThanOrEqual(Date.now() + 5000);
    }
    expect(editor.userId).not.toBe(owner.id);

    // Paging walks the same rows, newest first, with no gap or repeat.
    expect(await readAll(org.id, 3)).toEqual(entries);
    // Owners only (the matrix in rbac.int.test.ts covers it too); a stranger cannot learn the org exists.
    expect((await call("editor", "GET", `/orgs/${org.id}/audit`)).status).toBe(403);
    const stranger = await call("stranger", "GET", `/orgs/${org.id}/audit`);
    expect(stranger.status).toBe(404);
    expect(ErrorBody.parse(stranger.json).error).toBe("not_found");

    // An org the owner does not belong to hears nothing of their sign-in.
    const other = Org.parse((await call("stranger", "POST", "/orgs", { name: "Someone else's" })).json);
    expect((await call("stranger", "GET", `/orgs/${other.id}/audit`)).json).toEqual({ items: [], nextCursor: null });
  });

  test("audit rows cannot be updated or deleted through the API: no such route exists, and the rows stay as they were", async () => {
    const org = Org.parse((await call("owner", "POST", "/orgs", { name: "Untouchable" })).json);
    expect((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.editor, role: "editor" })).status).toBe(200);
    const before = await readAll(org.id);
    const [entry] = before;
    if (!entry) throw new Error("no audit entry");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of [`/orgs/${org.id}/audit`, `/orgs/${org.id}/audit/${entry.id}`]) {
        const res = await call("owner", method, path, method === "DELETE" ? undefined : { action: "signed_in" });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(await readAll(org.id)).toEqual(before);
  });

  test("a cursor this server did not issue is a 400, not a 500", async () => {
    const org = Org.parse((await call("owner", "POST", "/orgs", { name: "Cursor" })).json);
    expect((await call("owner", "GET", `/orgs/${org.id}/audit?cursor=nope`)).status).toBe(400);
  });
});
