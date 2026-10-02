import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { generate } from "@noon/codegen";
import { Document, Org, Run, User, Workspace, type Doc, type Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOp, emptyDoc } from "@noon/doc-model";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { sessionIdentity } from "../../api/src/identity.ts";
import { startServer, type RunningServer } from "../../api/src/server.ts";
import { TEST_SESSIONS } from "../../api/src/testing.ts";
import { connect, TEST_SECRET, useSyncServer } from "../../sync/src/testing.ts";
import { createAiHandler } from "./ai.ts";
import { createPushApplier } from "./push.ts";
import { pagePath } from "./sandbox.ts";

// integration:service-credential-peers-still-work (E8.1, F23). The api knows only sign-in sessions now (the
// strategy of every non-development process); the dev header is gone. The worker's AI and git peers are not
// people and never sign in: they hold the service credential, SESSION_TOKEN_SECRET, and mint their own sync
// session for the actor they are (agent + run, git + commit). A person signs up, starts a run, and an engineer
// pushes; both peers must still reach the room.
const sync = useSyncServer();
let t: TestDb, api: RunningServer;
beforeAll(async () => {
  expect(TEST_SECRET).toBe(TEST_SESSIONS.secret); // the api and the sync server share the credential, as in compose
  t = await createTestDb();
  api = await startServer({ port: 0, db: t.db, identify: sessionIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve() });
});
afterAll(async () => {
  await api.close();
  await t.drop();
});

const call = (method: string, path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${api.url}${path}`, { method, headers: { ...headers, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const usage = { model: "stub", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

test("a signed-in person starts an AI run and the agent's op reaches the room; an engineer's push reaches it too", async () => {
  const up = await fetch(`${api.url}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "svc@example.com", name: "Svc", password: "correct horse battery" }) });
  expect(up.status).toBe(201);
  const person = User.parse(await up.json());
  const cookie = /^(noon_session=[^;]*)/.exec(up.headers.get("set-cookie") ?? "")?.[1] ?? "";
  // The header that used to open every door opens none.
  expect((await call("GET", "/orgs", "", undefined, { "x-dev-user": "svc@example.com" })).status).toBe(401);

  const org = Org.parse(await (await call("POST", "/orgs", cookie, { name: "Service" })).json());
  const ws = Workspace.parse(await (await call("POST", `/orgs/${org.id}/workspaces`, cookie, { name: "ws" })).json());
  const doc = Document.parse(await (await call("POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, cookie, { title: "Checkout" })).json());
  expect((await call("POST", `/documents/${doc.id}/session`, cookie)).status).toBe(200);
  const run = Run.parse(await (await call("POST", `/documents/${doc.id}/runs`, cookie, { instruction: "add a card" })).json());

  const watcher = await connect(sync.server.url, doc.id, person.id, {}, doc.orgId);
  const sessions = { secret: TEST_SECRET, syncUrl: sync.server.url };
  const ai = createAiHandler({
    sessions, manifest, oauthToken: "stub", ready: Promise.resolve(), stopping: new AbortController().signal, report: () => Promise.resolve(),
    roleOf: async (documentId, userId) => (await t.db.getDocumentForMember(documentId, userId))?.role,
    runAgent: async ({ tools }) => {
      const added = await tools.find((tool) => tool.name === "add_node")?.run({ parentId: "root", component: "Card", props: {} });
      expect(added?.ok).toBe(true);
      return usage;
    },
  });
  await ai({ id: run.id, orgId: run.orgId, documentId: doc.id, queue: "ai", input: { instruction: run.instruction }, createdBy: person.id }, new AbortController().signal);
  const agentOp = await watcher.next("op", (m) => m.actor.kind === "agent");
  expect(agentOp).toMatchObject({ actor: { kind: "agent", id: person.id, runId: run.id }, op: { type: "add_node", component: "Card" } });

  // The engineer's push: the page as the room now holds it, plus a button.
  const current = watcher.inbox.flatMap((m) => (m.type === "op" ? [m.op] : [])).reduce<Doc>((d, op: Op) => applyOp(d, op), emptyDoc());
  const target = applyOp(current, { type: "add_node", nodeId: "from-git", parentId: "root", index: 99, component: "Button", props: { label: "Pay" } });
  const page = generate(target, manifest);
  if (!page.ok) throw new Error(page.reason);
  const toOps = createPushApplier({ sessions, manifest, documentOrg: (id) => Promise.resolve(id === doc.id ? doc.orgId : undefined), shippedCommit: () => Promise.resolve(false), pushedNodeIds: () => Promise.resolve(new Set<string>()) });
  const event = { id: randomUUID(), ref: `refs/heads/noon/${doc.id}`, before: "0".repeat(40), after: "a".repeat(40) };
  const outcome = await toOps(event, { documentId: doc.id, path: pagePath(doc.id), tsx: page.tsx }, () => Promise.resolve({ tsx: undefined, earlierIds: new Set() }));
  expect(outcome).toEqual({ kind: "applied", ops: 1, refused: 0 });
  expect(await watcher.next("op", (m) => m.actor.kind === "git")).toMatchObject({ actor: { kind: "git", id: event.id, runId: event.after }, op: { type: "add_node", nodeId: "from-git" } });
  watcher.close();
});
