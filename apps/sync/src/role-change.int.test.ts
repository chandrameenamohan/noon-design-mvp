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
import { TEST_SECRET, until, upgradeStatus } from "./testing.ts";

// integration:role-change-live-within-10s (E8.2, F24), and the sync half of the rbac matrix: the api, the sync
// server and Redis as in compose. The sync server reads each peer's role from Postgres when it joins; an owner's
// change goes api -> Redis pub/sub -> every sync node, which reads the role again for the sessions it concerns.
const prefix = `test-access-${randomUUID()}:`;
/** E8.3's race tests: runs after each role read has its answer and before the sync server gets it (a slow Postgres). */
let afterRead: ((userId: string) => Promise<void>) | undefined;
let t: TestDb, api: RunningServer, sync: RunningSyncServer;
let publisher: ReturnType<typeof accessPublisher>, subscriber: ReturnType<typeof accessSubscriber>;
beforeAll(async () => {
  expect(TEST_SECRET).toBe(TEST_SESSIONS.secret);
  t = await createTestDb();
  sync = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store: t.db.documentStore(), roles: async (orgId, documentId, userId) => {
    const role = await t.db.roleIn(orgId, documentId, userId);
    await afterRead?.(userId);
    return role;
  }, recoverMs: 50 });
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
function browser(who: string, documentId: string, at?: RunningSyncServer) {
  return connectPeer({
    manifest,
    retryMs: { min: 20, max: 100 },
    session: async () => {
      const res = await call(who, "POST", `/documents/${documentId}/session`);
      if (res.status === 404) return null; // "give up", as the web client does
      const { token } = SessionResponse.parse(await res.json());
      return { wsUrl: `${(at ?? sync).url}/documents/${documentId}`, token };
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
    await t.db.forOrg(org.id).setMember({ email: email("editor"), role: "viewer", by: undefined }); // behind the api's back: nothing announced
    const before = editor.submit(add());
    expect(before.ok && (await before.settled)).toMatchObject({ ok: true }); // nobody told the node yet
    await sync.recheck("all");
    const after = editor.submit(add());
    expect(after.ok && (await after.settled)).toEqual({ ok: false, reason: "forbidden" });
  } finally {
    editor.close();
  }
});

test("a token for someone who is not a member of the document's org is refused at the upgrade (401), and so is an AI run acting for one", async () => {
  const { doc } = await world({});
  for (const actor of [{ kind: "user" as const }, { kind: "agent" as const, runId: randomUUID() }]) {
    // Minted with the service credential, as the worker does: a valid signature is not membership (E8.3: read before the upgrade).
    const token = signSessionToken({ userId: randomUUID(), orgId: doc.orgId, documentId: doc.id, secret: TEST_SECRET, ttlSeconds: 60, actor });
    expect(await upgradeStatus(`${sync.url}/documents/${doc.id}`, ["noon.v1", token]), actor.kind).toBe(401);
    expect(sync.peerCount(doc.id)).toBe(0);
  }
});

test("an AI run acting for a viewer is refused like the viewer; the git peer (the service itself) is not asked", async () => {
  const { doc } = await world({ viewer: "viewer" });
  const viewerId = (await t.db.forOrg(doc.orgId).setMember({ email: email("viewer"), role: "viewer", by: undefined }));
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

// integration:share-revoke-token-race (E8.3, F25): a document shared with a user outside its org, then revoked. The
// revoke closes their live session, and neither a reconnect already on its way nor a token minted before the revoke
// (it lives 60 s) gets them back in: /session reads the share (404), and so does the sync upgrade (401).
const mint = async (who: string, documentId: string): Promise<string> => SessionResponse.parse(await (await call(who, "POST", `/documents/${documentId}/session`)).json()).token;
async function shareWithOutsider(documentId: string): Promise<Member> {
  expect((await call("outsider", "GET", "/orgs")).status).toBe(200); // the dev header creates them; they join no org
  return Member.parse(await (await call("owner", "PUT", `/documents/${documentId}/shares`, { email: email("outsider"), role: "editor" })).json());
}
const revoke = async (documentId: string, userId: string): Promise<void> => {
  expect((await call("owner", "DELETE", `/documents/${documentId}/shares/${userId}`)).status).toBe(204);
};

test("shared with an outside user, they edit live; revoked, their session closes within 10 s, no op reaches them after, and every way back is refused", async () => {
  const { doc } = await world({});
  const shared = await shareWithOutsider(doc.id);
  const owner = browser("owner", doc.id);
  const outsider = browser("outsider", doc.id);
  try {
    await until(() => owner.status === "live" && outsider.status === "live", "both live");
    const edit = outsider.submit(add());
    expect(edit.ok && (await edit.settled)).toMatchObject({ ok: true });
    const early = await mint("outsider", doc.id);

    const since = Date.now();
    await revoke(doc.id, shared.userId);
    await until(() => outsider.status === "closed", "the outsider's session is closed", 10_000);
    expect(Date.now() - since).toBeLessThan(10_000);
    expect(outsider.closedBecause).toBe("4404"); // fatal for the client: it does not come back by itself
    const seen = outsider.seq;
    const after = owner.submit(add());
    expect(after.ok && (await after.settled)).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(outsider.seq).toBe(seen);
    expect(sync.peerCount(doc.id)).toBe(1); // only the owner is in the room

    // Every way back is shut: a new session, the token minted before the revoke, and a peer reconnecting on its own.
    expect((await call("outsider", "POST", `/documents/${doc.id}/session`)).status).toBe(404);
    expect(await upgradeStatus(`${sync.url}/documents/${doc.id}`, ["noon.v1", early]), "a token minted before the revoke").toBe(401);
    const again = browser("outsider", doc.id);
    await until(() => again.status === "closed", "a reconnecting peer gives up");
    expect(again.closedBecause).toBe("no_session");
    again.close();
  } finally {
    owner.close();
    outsider.close();
  }
});

// The revoke lands while the peer is on its way in, its access already read as "shared": at the upgrade's own read
// (the socket is not registered yet, so the announcement finds nobody), or at the read serve() makes once it is (the
// announcement makes the node read again, and that newer answer wins over the late one).
for (const [nth, which] of [[1, "the upgrade's read"], [2, "the read after the socket is registered"]] as const) {
  test(`a revoke landing during ${which}, with a token minted before it, keeps the peer out: it never joins, and is closed (4404)`, async () => {
    const { doc } = await world({});
    const shared = await shareWithOutsider(doc.id);
    const token = await mint("outsider", doc.id);
    let reads = 0;
    const held = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    afterRead = async (userId) => {
      if (userId !== shared.userId || ++reads !== nth) return;
      held.resolve(undefined);
      await release.promise;
    };
    const statuses: string[] = [];
    const peer = connectPeer({
      manifest,
      retryMs: { min: 20, max: 100 },
      onStatus: (status) => { statuses.push(status); },
      session: () => Promise.resolve({ wsUrl: `${sync.url}/documents/${doc.id}`, token }),
    });
    try {
      await held.promise; // read as still shared; the answer is held on its way
      await revoke(doc.id, shared.userId); // committed and announced meanwhile
      if (nth === 2) await until(() => reads > 2, "the announcement made the node read again");
      release.resolve(undefined);
      await until(() => peer.status === "closed", "the peer is closed out");
      expect(peer.closedBecause).toBe("4404");
      expect(statuses).not.toContain("live"); // no welcome: it never saw the document
      expect(sync.peerCount(doc.id)).toBe(0);
    } finally {
      release.resolve(undefined);
      afterRead = undefined;
      peer.close();
    }
  });
}

test("a revoke nobody announced (Redis away at the api) still closes the session, at the sync node's next sweep", async () => {
  const swept = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store: t.db.documentStore(), roles: (orgId, documentId, userId) => t.db.roleIn(orgId, documentId, userId), sweepMs: 200 });
  const { doc } = await world({});
  const shared = await shareWithOutsider(doc.id);
  const outsider = browser("outsider", doc.id, swept);
  try {
    await until(() => outsider.status === "live", "outsider live");
    expect(await t.db.forOrg(doc.orgId).unshare(doc.id, shared.userId, undefined)).toBe(true); // behind the api's back: nothing announced
    await until(() => outsider.status === "closed", "closed by the sweep");
    expect(outsider.closedBecause).toBe("4404");
  } finally {
    outsider.close();
    await swept.close();
  }
});
