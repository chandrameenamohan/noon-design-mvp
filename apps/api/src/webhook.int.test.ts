import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { Document, Org, Workspace } from "@noon/contracts";
import { buildApp } from "./app.ts";
import { devHeaderIdentity } from "./identity.ts";
import { TEST_SESSIONS, TEST_WEBHOOK_SECRET, useTestServer } from "./testing.ts";

// E5.3a, integration:webhook-hmac-dedupe-synthetic. The real api over real Postgres, sent what Gitea sends
// (learning-tests/gitea FINDINGS 2-3): a JSON push, X-Gitea-Signature = hex HMAC-SHA256 of the raw body.
const ctx = useTestServer();
beforeEach(() => ctx.db.rawQuery("delete from git_events"));

const A = "1".repeat(40);
const B = "2".repeat(40);
const ZERO = "0".repeat(40);
const pushBody = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ ref: "refs/heads/main", before: A, after: B, commits: [{ id: B, added: [], removed: [], modified: ["src/pages/x.tsx"] }], repository: { full_name: "noon/sample-app" }, ...fields });
const sign = (body: string, secret = TEST_WEBHOOK_SECRET): string => createHmac("sha256", secret).update(body).digest("hex");

/** A delivery as Gitea makes it. No x-dev-user: Gitea is nobody, and the route must not need one. */
function deliver(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${ctx.server.url}/webhooks/gitea`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-delivery": randomUUID(), "x-gitea-signature": sign(body), ...headers },
    body,
  });
}
const events = async (): Promise<{ ref: string; before_sha: string; after_sha: string; delivery_id: string | null; status: string }[]> =>
  ((await ctx.db.rawQuery("select ref, before_sha, after_sha, delivery_id, status from git_events order by created_at")) as { rows: [] }).rows;

test("a signed push is one pending commit event: branch, before, after and its delivery id", async () => {
  const body = pushBody();
  const res = await deliver(body, { "x-gitea-delivery": "delivery-1" });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ result: "recorded" });
  expect(await events()).toEqual([{ ref: "refs/heads/main", before_sha: A, after_sha: B, delivery_id: "delivery-1", status: "pending" }]);
});

test("the same delivery again, and the same push replayed under a new delivery id, record nothing more", async () => {
  const body = pushBody();
  expect((await deliver(body, { "x-gitea-delivery": "same" })).status).toBe(202);
  const again = await deliver(body, { "x-gitea-delivery": "same" });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ result: "duplicate" });
  // The delivery id is not signed: a captured body replayed under a fresh id meets the (branch, commit) key.
  expect(await (await deliver(body, { "x-gitea-delivery": "fresh" })).json()).toEqual({ result: "duplicate" });
  // Ten at once: Postgres's unique key decides, not a look-then-insert in the api.
  const raced = await Promise.all(Array.from({ length: 10 }, () => deliver(pushBody({ before: B, after: A }))));
  expect(raced.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
  expect(await events()).toHaveLength(2);
});

test("without the right signature nothing is read or stored: 401", async () => {
  const body = pushBody();
  const wrong = [
    { "x-gitea-signature": sign(body, "another-secret-another-secret-another") },
    { "x-gitea-signature": sign(`${body} `) },
    { "x-gitea-signature": `sha256=${sign(body)}` },
    { "x-gitea-signature": sign(body).toUpperCase() },
    { "x-gitea-signature": "" },
  ];
  for (const headers of wrong) expect((await deliver(body, headers)).status, JSON.stringify(headers)).toBe(401);
  const unsigned = await fetch(`${ctx.server.url}/webhooks/gitea`, { method: "POST", headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-delivery": "x" }, body });
  expect(unsigned.status).toBe(401);
  // A body that is not even JSON is refused as unauthenticated, not as invalid: its content was never looked at.
  expect((await deliver("{not json", { "x-gitea-signature": "0".repeat(64) })).status).toBe(401);
  expect(await events()).toEqual([]);
});

test("the push Gitea fires when the hook is registered (before = zeros) is ignored", async () => {
  const res = await deliver(pushBody({ before: ZERO, commits: [] }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ result: "ignored", reason: "synthetic" });
  expect(await events()).toEqual([]);
});

test("a deleted branch, a tag and any event but a push are ignored; a signed body that is not a push is a 400", async () => {
  expect(await (await deliver(pushBody({ after: ZERO }))).json()).toEqual({ result: "ignored", reason: "deleted" });
  expect(await (await deliver(pushBody({ ref: "refs/tags/v1" }))).json()).toEqual({ result: "ignored", reason: "not_a_branch" });
  expect(await (await deliver(pushBody(), { "x-gitea-event": "issues" })).json()).toEqual({ result: "ignored", reason: "not_a_push" });
  expect((await deliver("{not json")).status).toBe(400);
  expect((await deliver(JSON.stringify({ ref: "refs/heads/main" }))).status).toBe(400);
  expect((await deliver(pushBody(), { "x-gitea-delivery": "" })).status).toBe(400);
  expect(await events()).toEqual([]);
});

test("a body over 1 MiB is refused by its length before it is read; a big but real push is taken", async () => {
  const big = pushBody({ commits: Array.from({ length: 400 }, (_, i) => ({ id: B, message: "m".repeat(400), modified: [`src/f${String(i)}.ts`] })) });
  expect(big.length).toBeGreaterThan(64 * 1024); // more than every other route accepts
  expect((await deliver(big)).status).toBe(202);
  const huge = pushBody({ padding: "x".repeat(1024 * 1024) });
  const res = await deliver(huge);
  expect(res.status).toBe(413);
  expect(await events()).toHaveLength(1);
});

test("every other route keeps its 64 KB limit", async () => {
  const res = await ctx.fetch("/orgs", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ name: "x".repeat(70 * 1024) }) }); // refused unread, so the server closes that socket: kept in fetch's pool, it gave the next request ECONNRESET
  expect(res.status).toBe(413);
});

test("with no secret configured the webhook does not exist", async () => {
  const app = buildApp({ db: ctx.db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve() });
  const body = pushBody();
  const res = await app.request("/webhooks/gitea", { method: "POST", headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-delivery": "d", "x-gitea-signature": sign(body) }, body });
  expect(res.status).toBe(404);
  expect(await events()).toEqual([]);
});

test("opening a document asks the git peer to reconcile (the missed delivery's other door)", async () => {
  const as = { "x-dev-user": "opener@example.com", "content-type": "application/json" };
  const org = Org.parse(await (await ctx.fetch("/orgs", { method: "POST", headers: as, body: JSON.stringify({ name: "Git" }) })).json());
  const ws = Workspace.parse(await (await ctx.fetch(`/orgs/${org.id}/workspaces`, { method: "POST", headers: as, body: JSON.stringify({ name: "ws" }) })).json());
  const doc = Document.parse(await (await ctx.fetch(`/orgs/${org.id}/workspaces/${ws.id}/documents`, { method: "POST", headers: as, body: JSON.stringify({ title: "Page" }) })).json());
  await ctx.db.db.gitStore().takeReconcileRequest();
  expect((await ctx.fetch(`/documents/${doc.id}/session`, { method: "POST", headers: as })).status).toBe(200);
  expect(await ctx.db.db.gitStore().takeReconcileRequest()).toBe(true);
});
