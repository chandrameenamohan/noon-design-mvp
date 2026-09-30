import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Document, ErrorBody, Member, MemberPage, Org, Workspace, type Role } from "@noon/contracts";
import { useTestServer } from "./testing.ts";

// integration:members-and-shares-listed (E10.8), role-gated. GET /orgs/:orgId/members: every member reads who is in
// THEIR org with their roles, oldest first; a stranger, and someone the org only shared a document with, are 404 (F2).
// GET /documents/:id/shares: the document's owner reads who it is shared with; an editor, a viewer and the person it is
// shared with are 403; a stranger 404; and nothing of another org's members or another document's shares comes along.
const ctx = useTestServer();
const tag = randomUUID().slice(0, 8);
const who = { owner: `list-owner-${tag}@example.com`, editor: `list-editor-${tag}@example.com`, viewer: `list-viewer-${tag}@example.com`, outsider: `list-outsider-${tag}@example.com`, stranger: `list-stranger-${tag}@example.com` };
type Who = keyof typeof who;

async function call(as: Who, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await ctx.fetch(path, { method, headers: { "x-dev-user": who[as], ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: res.status === 204 ? null : await res.json() };
}
const emailsOf = (json: unknown): string[] => MemberPage.parse(json).items.map((m) => m.email);
const rolesOf = (json: unknown): Record<string, Role> => Object.fromEntries(MemberPage.parse(json).items.map((m) => [m.email, m.role]));

/** An org with an owner, an editor and a viewer, one document shared with the outsider, and a second org of the stranger's. */
async function world() {
  for (const each of Object.keys(who) as Who[]) expect((await call(each, "GET", "/orgs")).status).toBe(200); // the dev header creates the user
  const org = Org.parse((await call("owner", "POST", "/orgs", { name: "Listed" })).json);
  expect(Member.parse((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.editor, role: "editor" })).json).role).toBe("editor");
  expect(Member.parse((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.viewer, role: "viewer" })).json).role).toBe("viewer");
  const ws = Workspace.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces`, { name: "ws" })).json);
  const doc = Document.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "shared" })).json);
  const other = Document.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "not shared" })).json);
  const shared = Member.parse((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.outsider, role: "viewer" })).json);
  // The stranger runs an org of their own, with the outsider in it: none of it may show through the first org's lists.
  const theirs = Org.parse((await call("stranger", "POST", "/orgs", { name: "Theirs" })).json);
  expect((await call("stranger", "PUT", `/orgs/${theirs.id}/members`, { email: who.outsider, role: "editor" })).status).toBe(200);
  return { org, doc, other, shared, theirs };
}

test("every member lists the org's members with their roles, oldest first; a stranger and a share-holder are 404; no other org's member shows", async () => {
  const { org, theirs } = await world();
  for (const as of ["owner", "editor", "viewer"] as const) {
    const res = await call(as, "GET", `/orgs/${org.id}/members`);
    expect(res.status, as).toBe(200);
    expect(emailsOf(res.json), as).toEqual([who.owner, who.editor, who.viewer]); // the founding owner first, then as added
    expect(rolesOf(res.json), as).toEqual({ [who.owner]: "owner", [who.editor]: "editor", [who.viewer]: "viewer" });
  }
  for (const as of ["stranger", "outsider"] as const) {
    const res = await call(as, "GET", `/orgs/${org.id}/members`);
    expect(res.status, as).toBe(404); // a share opens one document, never the org (F25); a stranger never learns the org exists (F2)
    expect(ErrorBody.parse(res.json).error).toBe("not_found");
  }
  // The other org's list is its own: the owner of the first org is a stranger there.
  expect((await call("owner", "GET", `/orgs/${theirs.id}/members`)).status).toBe(404);
  expect(emailsOf((await call("stranger", "GET", `/orgs/${theirs.id}/members`)).json)).toEqual([who.stranger, who.outsider]);
});

test("a role change shows in the very next list, and a member added is listed last", async () => {
  const { org } = await world();
  expect((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.viewer, role: "editor" })).status).toBe(200);
  expect(rolesOf((await call("viewer", "GET", `/orgs/${org.id}/members`)).json)[who.viewer]).toBe("editor");
  expect((await call("owner", "PUT", `/orgs/${org.id}/members`, { email: who.stranger, role: "viewer" })).status).toBe(200);
  expect(emailsOf((await call("stranger", "GET", `/orgs/${org.id}/members`)).json)).toEqual([who.owner, who.editor, who.viewer, who.stranger]);
});

test("the list is paged like every other: a limit, a cursor to the rest, and a made-up cursor is refused", async () => {
  const { org } = await world();
  const first = await call("owner", "GET", `/orgs/${org.id}/members?limit=2`);
  const page = MemberPage.parse(first.json);
  expect(page.items.map((m) => m.email)).toEqual([who.owner, who.editor]);
  expect(page.nextCursor).not.toBeNull();
  const rest = MemberPage.parse((await call("owner", "GET", `/orgs/${org.id}/members?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? "")}`)).json);
  expect(rest.items.map((m) => m.email)).toEqual([who.viewer]);
  expect(rest.nextCursor).toBeNull();
  expect((await call("owner", "GET", `/orgs/${org.id}/members?cursor=not-a-cursor`)).status).toBe(400);
});

test("only the owner lists a document's shares: the outsider it is shared with, at their role; editor, viewer and the outsider are 403; a stranger 404", async () => {
  const { org, doc, other, shared } = await world();
  const res = await call("owner", "GET", `/documents/${doc.id}/shares`);
  expect(res.status).toBe(200);
  expect(MemberPage.parse(res.json).items).toEqual([{ userId: shared.userId, email: who.outsider, name: shared.name, role: "viewer" }]);
  expect(MemberPage.parse((await call("owner", "GET", `/documents/${other.id}/shares`)).json).items).toEqual([]); // only that document's
  for (const as of ["editor", "viewer", "outsider"] as const) {
    const refused = await call(as, "GET", `/documents/${doc.id}/shares`);
    expect(refused.status, as).toBe(403); // they may open the document, so "not found" would be a lie; the list is not theirs
    expect(ErrorBody.parse(refused.json).error).toBe("forbidden");
  }
  const stranger = await call("stranger", "GET", `/documents/${doc.id}/shares`);
  expect(stranger.status).toBe(404);
  expect(ErrorBody.parse(stranger.json).error).toBe("not_found");
  // A share never makes a member: the org's member list is unchanged by it.
  expect(emailsOf((await call("owner", "GET", `/orgs/${org.id}/members`)).json)).not.toContain(who.outsider);
});

test("a share changed shows at its new role, and a share revoked is gone from the very next list", async () => {
  const { doc, shared } = await world();
  expect((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.outsider, role: "editor" })).status).toBe(200);
  expect(rolesOf((await call("owner", "GET", `/documents/${doc.id}/shares`)).json)).toEqual({ [who.outsider]: "editor" });
  expect((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.viewer, role: "editor" })).status).toBe(200); // a member's share lifts them (E8.3)
  expect(emailsOf((await call("owner", "GET", `/documents/${doc.id}/shares`)).json)).toEqual([who.outsider, who.viewer]);
  expect((await call("owner", "DELETE", `/documents/${doc.id}/shares/${shared.userId}`)).status).toBe(204);
  expect(emailsOf((await call("owner", "GET", `/documents/${doc.id}/shares`)).json)).toEqual([who.viewer]);
  expect((await call("owner", "GET", `/documents/${doc.id}/shares?cursor=not-a-cursor`)).status).toBe(400);
});
