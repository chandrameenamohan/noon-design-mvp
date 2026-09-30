import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Document, Member, Org, SessionResponse, Workspace, type Op, type Role } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { accessPublisher, accessSubscriber } from "@noon/lease";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { TEST_REDIS_URL } from "../../../packages/queue/src/testing.ts";
import { devHeaderIdentity } from "../../api/src/identity.ts";
import { startServer, type RunningServer } from "../../api/src/server.ts";
import { TEST_SESSIONS } from "../../api/src/testing.ts";
import { startSyncServer, type RunningSyncServer } from "./server.ts";
import { TEST_SECRET, until } from "./testing.ts";

// integration:role-change-live-within-10s (E8.2, F24), and the sync half of the rbac matrix: the api, the sync
// server and Redis as in compose. The sync server reads each peer's role from Postgres when it joins; an owner's
// change goes api -> Redis pub/sub -> every sync node, which reads the role again for the sessions it concerns.
const prefix = `test-access-${randomUUID()}:`;
let t: TestDb, api: RunningServer, sync: RunningSyncServer;
let publisher: ReturnType<typeof accessPublisher>, subscriber: ReturnType<typeof accessSubscriber>;
beforeAll(async () => {
  expect(TEST_SECRET).toBe(TEST_SESSIONS.secret);
  t = await createTestDb();
  sync = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store: t.db.documentStore(), roles: (orgId, documentId, userId) => t.db.roleIn(orgId, documentId, userId), recoverMs: 50 });
  subscriber = accessSubscriber({ redisUrl: TEST_REDIS_URL, prefix, onChange: (change) => void sync.recheck(change) });
  await subscriber.subscribed;
  publisher = accessPublisher({ redisUrl: TEST_REDIS_URL, prefix });
  api = await startServer({ port: 0, db: t.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), accessChanged: (change) => publisher.publish(change) });
});
afterAll(async () => {
  await api.close();
  await publisher.close();
  await subscriber.close();
  await sync.close();
  await t.drop();
});

const tag = randomUUID().slice(0, 8);
const email = (name: string): string => `role-${name}-${tag}@example.com`;
async function call(as: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${api.url}${path}`, { method, headers: { "x-dev-user": email(as), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const setRole = async (orgId: string, who: string, role: Role): Promise<Member> => Member.parse(await (await call("owner", "PUT", `/orgs/${orgId}/members`, { email: email(who), role })).json());
const add = (): Op => ({ type: "add_node", nodeId: randomUUID(), parentId: ROOT_ID, index: 0, component: "Stack", props: {} });

/** An org with a document; each of `members` joined at its role (the dev header creates the user on first sight). */
async function world(members: Record<string, Role>) {
  for (const who of ["owner", ...Object.keys(members)]) expect((await call(who, "GET", "/orgs")).status).toBe(200);
  const org = Org.parse(await (await call("owner", "POST", "/orgs", { name: "Roles" })).json());
  for (const [who, role] of Object.entries(members)) await setRole(org.id, who, role);
  const ws = Workspace.parse(await (await call("owner", "POST", `/orgs/${org.id}/workspaces`, { name: "ws" })).json());
  const doc = Document.parse(await (await call("owner", "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "doc" })).json());
  return { org, doc };
}

/** A browser's peer: its session from the api as `who`, its socket to this test's sync server. */
function browser(who: string, documentId: string) {
  return connectPeer({
    manifest,
    retryMs: { min: 20, max: 100 },
    session: async () => {
      const res = await call(who, "POST", `/documents/${documentId}/session`);
      if (res.status === 404) return null; // "give up", as the web client does
      const { token } = SessionResponse.parse(await res.json());
      return { wsUrl: `${sync.url}/documents/${documentId}`, token };
    },
  });
}

test("a viewer sees the others' edits and presence live, and every op it sends is rejected as forbidden", async () => {
  const { doc } = await world({ viewer: "viewer" });
  const owner = browser("owner", doc.id);
  const viewer = browser("viewer", doc.id);
  try {
    await until(() => owner.status === "live" && viewer.status === "live", "both live");
    const edit = owner.submit(add());
    expect(edit.ok && (await edit.settled)).toEqual({ ok: true, seq: 1 });
    await until(() => viewer.seq === 1, "the viewer sees the owner's edit");
    owner.setPresence({ cursor: { x: 0.25, y: 0.75 }, selection: null });
    await until(() => viewer.others.some((p) => p.cursor?.x === 0.25), "the viewer sees the owner's pointer");

    for (const op of [add(), { type: "remove_node", nodeId: Object.keys(owner.confirmed.nodes).find((id) => id !== ROOT_ID) ?? "" } satisfies Op]) {
      const tried = viewer.submit(op);
      expect(tried.ok && (await tried.settled)).toEqual({ ok: false, reason: "forbidden" });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(owner.seq).toBe(1); // nothing of the viewer's reached anyone
    expect(viewer.status).toBe("live"); // refused, not thrown out: it goes on watching
  } finally {
    owner.close();
    viewer.close();
  }
});

test("an owner demotes an editor with the document open: its next op is refused within 10 s; promoted again, it edits within 10 s", async () => {
  const { org, doc } = await world({ editor: "editor" });
  const editor = browser("editor", doc.id);
  try {
    await until(() => editor.status === "live", "editor live");
    const first = editor.submit(add());
    expect(first.ok && (await first.settled)).toMatchObject({ ok: true });

    /** Submits an op every 100 ms until one settles as `want`; returns how long that took. */
    async function msUntil(want: "forbidden" | "accepted"): Promise<number> {
      const since = Date.now();
      for (;;) {
        const tried = editor.submit(add());
        const outcome = tried.ok ? await tried.settled : tried;
        if (want === "forbidden" ? !outcome.ok && outcome.reason === "forbidden" : outcome.ok) return Date.now() - since;
        if (Date.now() - since > 10_000) throw new Error(`no ${want} op within 10 s`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await setRole(org.id, "editor", "viewer");
    expect(await msUntil("forbidden")).toBeLessThan(10_000);
    expect(editor.status).toBe("live"); // the SAME connection: no reconnect was needed for the change to apply
    await setRole(org.id, "editor", "editor");
    expect(await msUntil("accepted")).toBeLessThan(10_000);
  } finally {
    editor.close();
  }
});

test("a node that missed the announcement reads every live session's role again when told 'all' (its subscription came back)", async () => {
  const { org, doc } = await world({ editor: "editor" });
  const editor = browser("editor", doc.id);
  try {
    await until(() => editor.status === "live", "editor live");
    await t.db.forOrg(org.id).setMember({ email: email("editor"), role: "viewer" }); // behind the api's back: nothing announced
    const before = editor.submit(add());
    expect(before.ok && (await before.settled)).toMatchObject({ ok: true }); // nobody told the node yet
    await sync.recheck("all");
    const after = editor.submit(add());
    expect(after.ok && (await after.settled)).toEqual({ ok: false, reason: "forbidden" });
  } finally {
    editor.close();
  }
});

test("a token for someone who is not a member of the document's org is closed out (4404), and so is an AI run acting for one", async () => {
  const { doc } = await world({});
  for (const actor of [{ kind: "user" as const }, { kind: "agent" as const, runId: randomUUID() }]) {
    const stranger = connectPeer({
      manifest,
      retryMs: { min: 20, max: 100 },
      // Minted with the service credential, as the worker does: a valid signature is not membership.
      session: () => Promise.resolve({ wsUrl: `${sync.url}/documents/${doc.id}`, token: signSessionToken({ userId: randomUUID(), orgId: doc.orgId, documentId: doc.id, secret: TEST_SECRET, ttlSeconds: 60, actor }) }),
    });
    try {
      await until(() => stranger.closedBecause !== undefined, `the ${actor.kind} stranger is closed out`);
      expect(stranger.closedBecause).toBe("4404");
      expect(sync.peerCount(doc.id)).toBe(0);
    } finally {
      stranger.close();
    }
  }
});

test("an AI run acting for a viewer is refused like the viewer; the git peer (the service itself) is not asked", async () => {
  const { doc } = await world({ viewer: "viewer" });
  const viewerId = (await t.db.forOrg(doc.orgId).setMember({ email: email("viewer"), role: "viewer" }));
  if (typeof viewerId === "string") throw new Error(viewerId);
  const peerAs = (userId: string, actor: { kind: "agent" | "git"; runId: string }) => connectPeer({
    manifest,
    retryMs: { min: 20, max: 100 },
    session: () => Promise.resolve({ wsUrl: `${sync.url}/documents/${doc.id}`, token: signSessionToken({ userId, orgId: doc.orgId, documentId: doc.id, secret: TEST_SECRET, ttlSeconds: 60, actor }) }),
  });
  const ai = peerAs(viewerId.userId, { kind: "agent", runId: randomUUID() });
  const git = peerAs(randomUUID(), { kind: "git", runId: "c".repeat(40) });
  try {
    await until(() => ai.status === "live" && git.status === "live", "both live");
    const byAi = ai.submit(add());
    expect(byAi.ok && (await byAi.settled)).toEqual({ ok: false, reason: "forbidden" });
    const byGit = git.submit(add());
    expect(byGit.ok && (await byGit.settled)).toMatchObject({ ok: true });
  } finally {
    ai.close();
    git.close();
  }
});
