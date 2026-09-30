import { expect, test } from "vitest";
import { Document, ErrorBody, Org, SessionResponse, Workspace } from "@noon/contracts";
import type { Holder } from "@noon/lease";
import { verifySessionToken } from "@noon/session-token";
import { devHeaderIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { TEST_SESSIONS, useTestServer } from "./testing.ts";

const ctx = useTestServer();
const as = (user: string | undefined, method: string, path: string, body?: unknown) =>
  ctx.fetch(path, {
    method,
    headers: { ...(user === undefined ? { "x-dev-user": "" } : { "x-dev-user": user }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function aDocument(owner: string): Promise<Document> {
  const org = Org.parse(await (await as(owner, "POST", "/orgs", { name: "Sessions" })).json());
  const ws = Workspace.parse(await (await as(owner, "POST", `/orgs/${org.id}/workspaces`, { name: "ws" })).json());
  return Document.parse(await (await as(owner, "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Checkout" })).json());
}

test("a member gets a sync address and a short-lived token that names the document, org and user", async () => {
  const doc = await aDocument("ann@example.com");
  const before = Math.floor(Date.now() / 1000);
  const res = await as("ann@example.com", "POST", `/documents/${doc.id}/session`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store"); // a credential must never be cached
  const session = SessionResponse.parse(await res.json());

  expect(session.wsUrl).toBe(`${TEST_SESSIONS.syncUrl}/documents/${doc.id}`);
  const verified = verifySessionToken({ token: session.token, secrets: [TEST_SESSIONS.secret], documentId: doc.id });
  expect(verified).toMatchObject({ ok: true, claims: { documentId: doc.id, orgId: doc.orgId } });
  if (!verified.ok) throw new Error("unreachable");
  expect(verified.claims.expiresAt - before).toBeGreaterThanOrEqual(TEST_SESSIONS.ttlSeconds);
  expect(verified.claims.expiresAt - before).toBeLessThanOrEqual(TEST_SESSIONS.ttlSeconds + 5);
  expect(session.expiresAt).toBe(new Date(verified.claims.expiresAt * 1000).toISOString());

  const me = await ctx.db.rawQuery("select id from users where email = 'ann@example.com'");
  expect(verified.claims.userId).toBe((me as { rows: { id: string }[] }).rows[0]?.id);
});

test("an unknown document, a malformed id and someone else's document are the same 404", async () => {
  const doc = await aDocument("owner@example.com");
  const answers = await Promise.all(
    [`/documents/00000000-0000-4000-8000-000000000000/session`, `/documents/nope/session`, `/documents/${doc.id}/session`].map(async (path) => {
      const res = await as("outsider@example.com", "POST", path);
      return { status: res.status, text: await res.text() };
    }),
  );
  for (const answer of answers) {
    expect(answer.status).toBe(404);
    expect(answer.text).toBe(answers[0]?.text);
    expect(ErrorBody.parse(JSON.parse(answer.text)).error).toBe("not_found");
  }
});

test("without a caller it is 401, and the response never carries a token", async () => {
  const doc = await aDocument("someone@example.com");
  const res = await as(undefined, "POST", `/documents/${doc.id}/session`);
  expect(res.status).toBe(401);
  expect(await res.text()).not.toMatch(/token|wsUrl/);
});

test("with several sync nodes the address is the room owner's, any node's while nobody owns it, and 503 when Redis cannot say", async () => {
  const doc = await aDocument("nodes@example.com");
  let owner: () => Promise<Holder | undefined> = () => Promise.resolve({ token: 4, nodeId: "sync-2" });
  const nodes = new Map([["sync", "wss://noon.example.com/sync"], ["sync-2", "wss://noon.example.com/sync-2"]]);
  const api = await startServer({ port: 0, db: ctx.db.db, identify: devHeaderIdentity, sessions: { ...TEST_SESSIONS, sync: { kind: "many", nodes } }, enqueue: () => Promise.resolve(), owner: () => owner() });
  try {
    const session = async () => fetch(`${api.url}/documents/${doc.id}/session`, { method: "POST", headers: { "x-dev-user": "nodes@example.com" } });
    expect(SessionResponse.parse(await (await session()).json()).wsUrl).toBe(`wss://noon.example.com/sync-2/documents/${doc.id}`);
    owner = () => Promise.resolve(undefined);
    expect([...nodes.values()].map((url) => `${url}/documents/${doc.id}`)).toContain(SessionResponse.parse(await (await session()).json()).wsUrl);
    owner = () => Promise.reject(new Error("redis did not answer"));
    const refused = await session();
    expect(refused.status).toBe(503);
    expect(ErrorBody.parse(await refused.json()).error).toBe("sync_unavailable");
  } finally {
    await api.close();
  }
});
