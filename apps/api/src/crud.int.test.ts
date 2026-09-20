import { expect, test } from "vitest";
import { Document, ErrorBody, Org, Workspace } from "@noon/contracts";
import { devHeaderIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { TEST_SESSIONS, useTestServer } from "./testing.ts";

const ctx = useTestServer();

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await ctx.fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

test("create an org, then a workspace and a document in it, and read each back", async () => {
  const org = Org.parse((await call("POST", "/orgs", { name: "Acme" })).json);
  expect(Org.parse((await call("GET", `/orgs/${org.id}`)).json)).toEqual(org);

  const created = await call("POST", `/orgs/${org.id}/workspaces`, { name: "Design" });
  expect(created.status).toBe(201);
  const ws = Workspace.parse(created.json);
  expect((await call("GET", `/orgs/${org.id}/workspaces`)).json).toEqual({ items: [ws], nextCursor: null });
  expect((await call("GET", `/orgs/${org.id}/workspaces/${ws.id}`)).json).toEqual(ws);

  const doc = Document.parse((await call("POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Checkout" })).json);
  expect((await call("GET", `/orgs/${org.id}/workspaces/${ws.id}/documents`)).json).toEqual({ items: [doc], nextCursor: null });
  expect((await call("GET", `/orgs/${org.id}/documents/${doc.id}`)).json).toEqual(doc);
});

test.each([
  ["a missing field", {}, "name"],
  ["a blank name", { name: "   " }, "name"],
  ["a wrong type", { name: 42 }, "name"],
  ["an unknown extra field", { name: "ok", nmae: "typo" }, "nmae"],
])("a body with %s gets 400 and names the field", async (_label, body, field) => {
  const res = await call("POST", "/orgs", body);
  expect(res.status).toBe(400);
  const err = ErrorBody.parse(res.json);
  expect(err.error).toBe("invalid_body");
  expect(err.issues?.map((i) => i.field)).toContain(field);
});

test("a body that is not JSON gets 400 invalid_json", async () => {
  const res = await call("POST", "/orgs", "{not json");
  expect(res.status).toBe(400);
  expect(ErrorBody.parse(res.json).error).toBe("invalid_json");
});

test("things that do not exist are 404: unknown ids, malformed ids, a workspace in another org", async () => {
  const a = Org.parse((await call("POST", "/orgs", { name: "A" })).json);
  const b = Org.parse((await call("POST", "/orgs", { name: "B" })).json);
  const wsA = Workspace.parse((await call("POST", `/orgs/${a.id}/workspaces`, { name: "ws" })).json);
  const ghost = "00000000-0000-4000-8000-000000000000";

  for (const path of [
    `/orgs/${ghost}`,
    `/orgs/not-a-uuid`,
    `/orgs/${a.id}/workspaces/${ghost}`,
    `/orgs/${a.id}/workspaces/not-a-uuid`,
    `/orgs/${b.id}/workspaces/${wsA.id}`, // real workspace, wrong org
    `/orgs/${a.id}/documents/${ghost}`,
  ]) {
    const res = await call("GET", path);
    expect(res.status, path).toBe(404);
    expect(ErrorBody.parse(res.json).error, path).toBe("not_found");
  }
  // Creating under something that does not exist in this org is also 404, and creates nothing.
  expect((await call("POST", `/orgs/${ghost}/workspaces`, { name: "w" })).status).toBe(404);
  expect((await call("POST", `/orgs/${b.id}/workspaces/${wsA.id}/documents`, { title: "sneaky" })).status).toBe(404);
  expect((await call("GET", `/orgs/${a.id}/workspaces/${wsA.id}/documents`)).json).toEqual({ items: [], nextCursor: null });
});

test("a database failure is a 500 that says nothing about the database", async () => {
  const broken = await startServer({ port: 0, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), db: { ...ctx.db.db, createOrg: () => Promise.reject(new Error('relation "orgs" does not exist; password=hunter2')) } });
  try {
    const res = await fetch(`${broken.url}/orgs`, { method: "POST", headers: { "content-type": "application/json", "x-dev-user": "tester@example.com" }, body: '{"name":"x"}' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal" });
    expect(text).not.toMatch(/relation|orgs|hunter2/);
  } finally {
    await broken.close();
  }
});
