import { expect, test } from "vitest";
import { ErrorBody, Org, Workspace } from "@noon/contracts";
import { devHeaderIdentity, noIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { TEST_SESSIONS, useTestServer } from "./testing.ts";

const ctx = useTestServer();

async function as(user: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string; headers: string }> {
  const res = await fetch(`${ctx.server.url}${path}`, {
    method,
    headers: { ...(user ? { "x-dev-user": user } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const headers = ["content-type", "cache-control", "x-content-type-options", "content-length"].map((h) => `${h}: ${res.headers.get(h) ?? ""}`).join("\n");
  return { status: res.status, json: JSON.parse(text) as unknown, text, headers };
}

test("without an identity every route except the probes is 401", async () => {
  for (const [method, path] of [["GET", "/orgs"], ["POST", "/orgs"], ["GET", "/orgs/00000000-0000-4000-8000-000000000000"]] as const) {
    const res = await as(undefined, method, path, method === "POST" ? { name: "x" } : undefined);
    expect(res.status, `${method} ${path}`).toBe(401);
    expect(ErrorBody.parse(res.json).error).toBe("unauthenticated");
  }
  expect((await as(undefined, "GET", "/health")).status).toBe(200);
  expect((await as(undefined, "GET", "/ready")).status).toBe(200);
  expect((await as("not-an-email", "GET", "/orgs")).status).toBe(401);
});

test("identity fails CLOSED: a route nobody has written yet is 401 without a caller, not a public 404", async () => {
  expect((await as(undefined, "POST", "/documents/00000000-0000-4000-8000-000000000000/session")).status).toBe(401);
  expect((await as(undefined, "GET", "/anything/at/all")).status).toBe(401);
  expect((await as("ann@example.com", "GET", "/anything/at/all")).status).toBe(404);
});

test("an email with a very long local part is a normal caller, not a 500", async () => {
  const res = await as(`${"a".repeat(250)}@example.com`, "GET", "/orgs");
  expect(res.status).toBe(200);
});

test("creating an org makes the caller its owner, and GET /orgs lists only the caller's orgs", async () => {
  const mine = Org.parse((await as("ann@example.com", "POST", "/orgs", { name: "Ann's org" })).json);
  const theirs = Org.parse((await as("bob@example.com", "POST", "/orgs", { name: "Bob's org" })).json);

  expect((await as("ann@example.com", "GET", "/orgs")).json).toEqual({ items: [mine], nextCursor: null });
  expect((await as("bob@example.com", "GET", "/orgs")).json).toEqual({ items: [theirs], nextCursor: null });
  expect((await as("nobody@example.com", "GET", "/orgs")).json).toEqual({ items: [], nextCursor: null });
  expect(await ctx.db.rawQuery("select role from memberships where org_id = $1", [mine.id])).toMatchObject({ rows: [{ role: "owner" }] });
});

test("a caller outside the org gets exactly 404, never 403, on every per-org route, and changes nothing", async () => {
  const org = Org.parse((await as("owner@example.com", "POST", "/orgs", { name: "Private" })).json);
  const ws = Workspace.parse((await as("owner@example.com", "POST", `/orgs/${org.id}/workspaces`, { name: "ws" })).json);
  const doc = (await as("owner@example.com", "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "d" })).json as { id: string };
  const ghost = "00000000-0000-4000-8000-000000000000";

  const routes: [string, string, unknown?][] = [
    ["GET", `/orgs/${org.id}`],
    ["GET", `/orgs/${org.id}/workspaces`],
    ["POST", `/orgs/${org.id}/workspaces`, { name: "sneaky" }],
    ["GET", `/orgs/${org.id}/workspaces/${ws.id}`],
    ["GET", `/orgs/${org.id}/workspaces/${ws.id}/documents`],
    ["POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "sneaky" }],
    ["GET", `/orgs/${org.id}/documents/${doc.id}`],
  ];
  for (const [method, path, body] of routes) {
    const outsider = await as("outsider@example.com", method, path, body);
    const missing = await as("outsider@example.com", method, path.replace(org.id, ghost), body);
    expect(outsider.status, `${method} ${path}`).toBe(404);
    expect(outsider.status).not.toBe(403);
    // Indistinguishable from an org that does not exist: the response must not confirm it is real.
    expect(missing.status, `${method} ${path}`).toBe(404);
    expect(outsider.text, `${method} ${path}`).toBe(missing.text); // byte for byte
    expect(outsider.headers, `${method} ${path}`).toBe(missing.headers);
  }
  expect((await as("owner@example.com", "GET", `/orgs/${org.id}/workspaces`)).json).toMatchObject({ items: [ws] });
  expect((await as("owner@example.com", "GET", `/orgs/${org.id}/workspaces/${ws.id}/documents`)).json).toMatchObject({ items: [doc] });
});

test("the dev header is never trusted in production", async () => {
  const prod = await startServer({ port: 0, db: ctx.db.db, identify: noIdentity, sessions: TEST_SESSIONS });
  try {
    const res = await fetch(`${prod.url}/orgs`, { headers: { "x-dev-user": "ann@example.com" } });
    expect(res.status).toBe(401);
  } finally {
    await prod.close();
  }
  expect(devHeaderIdentity).not.toBe(noIdentity);
});
