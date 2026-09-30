import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Document, ErrorBody, Me, Member, Org, Run, Workspace, type Role } from "@noon/contracts";
import { useTestServer } from "./testing.ts";

// integration:rbac-matrix (E8.2, F24). Every org and document route, as an owner, an editor, a viewer and a
// stranger: a member without the role gets 403 (they can see the thing), a stranger 404 (F2: never confirm it
// exists). Reads are open to every member; writes need an editor; roles, shares, usage and the audit trail need an owner. The sync side of
// the matrix (a viewer's ops) is apps/sync/src/role-change.int.test.ts.
const announced: { orgId: string; userId: string }[] = [];
const ctx = useTestServer({ accessChanged: (change) => { announced.push(change); return Promise.resolve(); } });
const tag = randomUUID().slice(0, 8);
const who = { owner: `rbac-owner-${tag}@example.com`, editor: `rbac-editor-${tag}@example.com`, viewer: `rbac-viewer-${tag}@example.com`, stranger: `rbac-stranger-${tag}@example.com` };
type Who = keyof typeof who;

async function call(as: Who, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await ctx.fetch(path, { method, headers: { "x-dev-user": who[as], ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: res.status === 204 ? null : await res.json() };
}
const setRole = (as: Who, orgId: string, email: string, role: Role) => call(as, "PUT", `/orgs/${orgId}/members`, { email, role });

async function world() {
  for (const each of Object.keys(who) as Who[]) expect((await call(each, "GET", "/orgs")).status).toBe(200); // the dev header creates the user
  const org = Org.parse((await call("owner", "POST", "/orgs", { name: "RBAC" })).json);
  expect(Member.parse((await setRole("owner", org.id, who.editor, "editor")).json)).toMatchObject({ email: who.editor, role: "editor" });
  expect(Member.parse((await setRole("owner", org.id, who.viewer, "viewer")).json)).toMatchObject({ email: who.viewer, role: "viewer" });
  const ws = Workspace.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces`, { name: "ws" })).json);
  const doc = Document.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "doc" })).json);
  const run = Run.parse((await call("owner", "POST", `/documents/${doc.id}/runs`, { instruction: "add a card" })).json);
  return { org, ws, doc, run };
}

test("every route, every role: reads for every member, writes for editors, roles and usage for owners, 404 for a stranger", async () => {
  const { org, ws, doc, run } = await world();
  const strangerId = Me.parse((await call("stranger", "GET", "/auth/me")).json).user?.id ?? "";
  // [method, path, body, least role]. Each write is one a viewer could do harm with; the stranger row is implied.
  const routes: [string, string, unknown, Role][] = [
    ["GET", `/orgs/${org.id}`, undefined, "viewer"],
    ["GET", `/orgs/${org.id}/members`, undefined, "viewer"], // E10.8
    ["GET", `/orgs/${org.id}/workspaces`, undefined, "viewer"],
    ["GET", `/orgs/${org.id}/workspaces/${ws.id}`, undefined, "viewer"],
    ["GET", `/orgs/${org.id}/workspaces/${ws.id}/documents`, undefined, "viewer"],
    ["GET", `/orgs/${org.id}/documents/${doc.id}`, undefined, "viewer"],
    ["POST", `/orgs/${org.id}/workspaces`, { name: "more" }, "editor"],
    ["POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "more" }, "editor"],
    ["GET", `/orgs/${org.id}/usage`, undefined, "owner"],
    ["GET", `/orgs/${org.id}/audit`, undefined, "owner"],
    ["PUT", `/orgs/${org.id}/members`, { email: who.viewer, role: "viewer" }, "owner"], // unchanged: the matrix must not move roles
    ["POST", `/documents/${doc.id}/session`, undefined, "viewer"],
    ["GET", `/documents/${doc.id}/runs/${run.id}`, undefined, "viewer"],
    ["POST", `/documents/${doc.id}/runs`, { instruction: "again" }, "editor"], // 409 for the allowed: a run is unfinished
    ["POST", `/documents/${doc.id}/runs/${run.id}/cancel`, undefined, "editor"],
    ["POST", `/documents/${doc.id}/preview`, undefined, "viewer"],
    ["GET", `/documents/${doc.id}/preview`, undefined, "viewer"],
    ["GET", `/documents/${doc.id}/conflict`, undefined, "viewer"],
    ["POST", `/documents/${doc.id}/ship`, undefined, "editor"],
    ["GET", `/documents/${doc.id}/ship`, undefined, "viewer"],
    // E8.3 (F25): the owner shares with the stranger (after every stranger row) and revokes it again. E10.8: and lists the shares.
    ["GET", `/documents/${doc.id}/shares`, undefined, "owner"],
    ["PUT", `/documents/${doc.id}/shares`, { email: who.stranger, role: "viewer" }, "owner"],
    ["DELETE", `/documents/${doc.id}/shares/${strangerId}`, undefined, "owner"],
  ];
  const rank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
  // Least privileged first: a denied write must be refused BEFORE it does anything the next row would see.
  for (const as of ["stranger", "viewer", "editor", "owner"] as const) {
    for (const [method, path, body, least] of routes) {
      const { status, json } = await call(as, method, path, body);
      const label = `${as} ${method} ${path}`;
      if (as === "stranger") {
        expect(status, label).toBe(404);
        expect(ErrorBody.parse(json).error, label).toBe("not_found");
      } else if (rank[as] < rank[least]) {
        expect(status, label).toBe(403);
        expect(ErrorBody.parse(json).error, label).toBe("forbidden");
      } else {
        expect([200, 201, 204, 409], label).toContain(status);
      }
    }
  }
  // The viewer's and editor's refused writes left nothing behind: only the owner's and editor's own creations.
  const workspaces = (await call("owner", "GET", `/orgs/${org.id}/workspaces`)).json as { items: unknown[] };
  expect(workspaces.items).toHaveLength(3); // the first, the editor's, the owner's
});

test("no escalation: an editor cannot change any role, their own included, and a viewer cannot either", async () => {
  const { org } = await world();
  for (const [as, email, role] of [["editor", who.editor, "owner"], ["editor", who.viewer, "editor"], ["viewer", who.viewer, "editor"], ["editor", who.owner, "viewer"]] as const) {
    const res = await setRole(as, org.id, email, role);
    expect(res.status, `${as} -> ${email} ${role}`).toBe(403);
  }
  expect((await call("editor", "GET", `/orgs/${org.id}/usage`)).status).toBe(403); // still an editor
  expect((await call("viewer", "POST", `/orgs/${org.id}/workspaces`, { name: "x" })).status).toBe(403); // still a viewer
});

test("an owner adds a member, promotes and demotes them, and every REST route follows at once; each change is announced", async () => {
  const { org, doc } = await world();
  announced.length = 0;
  expect((await call("viewer", "POST", `/documents/${doc.id}/runs/${randomUUID()}/cancel`)).status).toBe(403);
  expect(Member.parse((await setRole("owner", org.id, who.viewer, "editor")).json).role).toBe("editor");
  expect((await call("viewer", "POST", `/orgs/${org.id}/workspaces`, { name: "promoted" })).status).toBe(201);
  expect(Member.parse((await setRole("owner", org.id, who.viewer, "viewer")).json).role).toBe("viewer");
  expect((await call("viewer", "POST", `/orgs/${org.id}/workspaces`, { name: "demoted" })).status).toBe(403);
  // A stranger becomes a member the same way.
  expect((await call("stranger", "GET", `/orgs/${org.id}`)).status).toBe(404);
  expect(Member.parse((await setRole("owner", org.id, who.stranger, "viewer")).json).role).toBe("viewer");
  expect((await call("stranger", "GET", `/orgs/${org.id}`)).status).toBe(200);
  // One announcement per change, naming the org and the user whose role moved.
  const viewerId = Member.parse((await setRole("owner", org.id, who.viewer, "viewer")).json).userId; // the same role again: announced all the same
  const strangerId = Member.parse((await setRole("owner", org.id, who.stranger, "viewer")).json).userId;
  expect(announced).toEqual([viewerId, viewerId, strangerId, viewerId, strangerId].map((userId) => ({ orgId: org.id, userId })));
});

test("the last owner cannot step down or be demoted; with a second owner they can. An unknown email is 404", async () => {
  const { org } = await world();
  const res = await setRole("owner", org.id, who.owner, "editor");
  expect(res.status).toBe(409);
  expect(ErrorBody.parse(res.json).error).toBe("last_owner");
  expect((await setRole("owner", org.id, `nobody-${tag}@example.com`, "viewer")).status).toBe(404);
  expect((await setRole("owner", org.id, who.editor, "owner")).status).toBe(200);
  expect((await setRole("editor", org.id, who.owner, "viewer")).status).toBe(200); // the new owner demotes the first
  expect((await call("owner", "GET", `/orgs/${org.id}/usage`)).status).toBe(403);
});

test("two owners demoting each other at the same moment: exactly one wins, and the org keeps an owner", async () => {
  const { org } = await world();
  expect((await setRole("owner", org.id, who.editor, "owner")).status).toBe(200);
  const [a, b] = await Promise.all([setRole("owner", org.id, who.editor, "viewer"), setRole("editor", org.id, who.owner, "viewer")]);
  // The loser is no longer an owner when its change comes up (the caller's role is read again under the org's lock),
  // so it is refused as a non-owner, whichever request reached the lock first; a stale "owner" from before never acts.
  expect([a.status, b.status].sort()).toEqual([200, 403]);
  const [winner, loser] = a.status === 200 ? (["owner", "editor"] as const) : (["editor", "owner"] as const);
  const members = (await call(winner, "GET", `/orgs/${org.id}/members`)).json as { items: unknown[] };
  expect(members.items.map((m) => Member.parse(m)).filter((m) => m.role === "owner").map((m) => m.email)).toEqual([who[winner]]);
  // Deterministically, the request that lost the race: it passed the route's owner check before the other committed,
  // and reaches the lock as a viewer. It changes nothing.
  const loserId = Me.parse((await call(loser, "GET", "/auth/me")).json).user?.id;
  expect(await ctx.db.db.forOrg(org.id).setMember({ email: who.viewer, role: "editor", by: loserId })).toBe("forbidden");
  expect((await call(loser, "GET", `/orgs/${org.id}`)).status).toBe(200); // still a member, only not an owner
  expect(Member.parse((await setRole(winner, org.id, who.viewer, "viewer")).json).role).toBe("viewer"); // the viewer was never promoted
});

test("a member of org A who owns org B cannot change roles in A through B's standing", async () => {
  const { org } = await world();
  const theirs = Org.parse((await call("viewer", "POST", "/orgs", { name: "Viewer's own" })).json);
  expect((await setRole("viewer", theirs.id, who.stranger, "editor")).status).toBe(200); // their own org: fine
  expect((await setRole("viewer", org.id, who.viewer, "owner")).status).toBe(403); // A: still a viewer there
});

// E8.3 (F25). A share opens ONE document, at its role, and nothing of the org; revoking it is a 404 on the very next
// request (the lookup reads the row), so a revoked peer's next /session is refused and it gives up.
test("an owner shares a document with an outside user: that document's routes at the share's role, nothing of the org; revoked, 404 at once", async () => {
  const { org, doc, run } = await world();
  const other = Document.parse((await call("owner", "POST", `/orgs/${org.id}/workspaces/${doc.workspaceId}/documents`, { title: "not shared" })).json);
  announced.length = 0;
  const shared = Member.parse((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.stranger, role: "viewer" })).json);
  expect(shared).toMatchObject({ email: who.stranger, role: "viewer" });
  expect((await call("stranger", "POST", `/documents/${doc.id}/session`)).status).toBe(200);
  expect((await call("stranger", "GET", `/documents/${doc.id}/runs/${run.id}`)).status).toBe(200);
  expect((await call("stranger", "POST", `/documents/${doc.id}/ship`)).status).toBe(403); // a viewer's share
  expect((await call("stranger", "POST", `/documents/${other.id}/session`)).status).toBe(404); // only that document
  expect((await call("stranger", "GET", `/orgs/${org.id}`)).status).toBe(404); // and never the org
  expect((await call("stranger", "GET", `/orgs/${org.id}/documents/${doc.id}`)).status).toBe(404);
  expect(((await call("stranger", "GET", "/orgs")).json as { items: unknown[] }).items.map((o) => Org.parse(o).id)).not.toContain(org.id);

  expect(Member.parse((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.stranger, role: "editor" })).json).role).toBe("editor");
  expect((await call("stranger", "POST", `/documents/${doc.id}/ship`)).status).toBe(201); // editor now
  expect((await call("stranger", "PUT", `/documents/${doc.id}/shares`, { email: who.stranger, role: "editor" })).status).toBe(403); // sharing is the owners'

  expect((await call("owner", "DELETE", `/documents/${doc.id}/shares/${shared.userId}`)).status).toBe(204);
  for (const [method, path] of [["POST", `/documents/${doc.id}/session`], ["GET", `/documents/${doc.id}/runs/${run.id}`], ["GET", `/documents/${doc.id}/ship`]] as const) {
    const res = await call("stranger", method, path);
    expect(res.status, `${method} ${path}`).toBe(404);
    expect(ErrorBody.parse(res.json).error).toBe("not_found");
  }
  expect((await call("owner", "DELETE", `/documents/${doc.id}/shares/${shared.userId}`)).status).toBe(404); // nothing left to revoke
  expect(announced).toEqual([shared.userId, shared.userId, shared.userId].map((userId) => ({ orgId: org.id, userId })));
});

test("a share is never owner, is for someone who exists, and only an owner of the document's org shares or revokes", async () => {
  const { doc } = await world();
  expect((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.stranger, role: "owner" })).status).toBe(400);
  expect((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: `nobody-${tag}@example.com`, role: "viewer" })).status).toBe(404);
  const shared = Member.parse((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.stranger, role: "editor" })).json);
  for (const as of ["editor", "viewer", "stranger"] as const) {
    expect((await call(as, "PUT", `/documents/${doc.id}/shares`, { email: who.stranger, role: "viewer" })).status, as).toBe(403);
    expect((await call(as, "DELETE", `/documents/${doc.id}/shares/${shared.userId}`)).status, as).toBe(403);
  }
  // A member's share lifts them to the higher of the two, and revoking it leaves their org role.
  expect((await call("viewer", "POST", `/documents/${doc.id}/ship`)).status).toBe(403);
  expect((await call("owner", "PUT", `/documents/${doc.id}/shares`, { email: who.viewer, role: "editor" })).status).toBe(200);
  expect((await call("viewer", "POST", `/documents/${doc.id}/ship`)).status).toBe(201);
});
