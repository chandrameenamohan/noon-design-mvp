import { expect, test } from "vitest";
import { ErrorBody, Org, Workspace } from "@noon/contracts";
import type { Db } from "@noon/db";
import { devHeaderIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { TEST_SESSIONS, useTestServer } from "./testing.ts";

// Each test reproduces a finding from the E1.3 review panel.
const ctx = useTestServer();

const post = (path: string, body: string, contentType = "application/json") =>
  ctx.fetch(path, { method: "POST", headers: { "content-type": contentType }, body });

// Built from char codes so this source file itself contains no control characters.
const control = (code: number): string => `a${String.fromCharCode(code)}b`;

test.each([["a NUL byte", control(0)], ["a newline", control(10)], ["an escape character", control(27)]])(
  "a name containing %s is a 400 naming the field, not a 500 from the database",
  async (_label, name) => {
    const res = await post("/orgs", JSON.stringify({ name }));
    expect(res.status).toBe(400);
    expect(ErrorBody.parse(await res.json()).issues?.[0]?.field).toBe("name");
  },
);

test.each(["[]", '"hi"', "null", "42"])("a JSON body that is not an object (%s) names the field 'body'", async (raw) => {
  const res = await post("/orgs", raw);
  expect(res.status).toBe(400);
  expect(ErrorBody.parse(await res.json()).issues?.[0]?.field).toBe("body");
});

test("a body over 64 KB is refused with 413 before it is parsed", async () => {
  const res = await post("/orgs", JSON.stringify({ name: "x".repeat(70_000) }));
  expect(res.status).toBe(413);
  expect(ErrorBody.parse(await res.json()).error).toBe("payload_too_large");
});

test("a body that is not declared as JSON is refused with 415", async () => {
  const res = await post("/orgs", '{"name":"sneaky"}', "text/plain");
  expect(res.status).toBe(415);
  expect(ErrorBody.parse(await res.json()).error).toBe("unsupported_media_type");
});

test("responses carrying tenant data are never cached and never sniffed", async () => {
  const org = Org.parse(await (await post("/orgs", '{"name":"Headers"}')).json());
  const res = await ctx.fetch(`/orgs/${org.id}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("lists are paged: limit, an opaque cursor, and null when there is no more", async () => {
  const org = Org.parse(await (await post("/orgs", '{"name":"Paged"}')).json());
  for (const name of ["w1", "w2", "w3"]) await post(`/orgs/${org.id}/workspaces`, JSON.stringify({ name }));

  const get = async (q: string) => {
    const res = await ctx.fetch(`/orgs/${org.id}/workspaces${q}`);
    return { status: res.status, json: (await res.json()) as { items: unknown[]; nextCursor: string | null } };
  };
  const first = await get("?limit=2");
  expect(first.json.items.map((w) => Workspace.parse(w).name)).toEqual(["w1", "w2"]);
  expect(first.json.nextCursor).toEqual(expect.any(String));

  const second = await get(`?limit=2&cursor=${encodeURIComponent(first.json.nextCursor ?? "")}`);
  expect(second.json.items.map((w) => Workspace.parse(w).name)).toEqual(["w3"]);
  expect(second.json.nextCursor).toBeNull();

  expect((await get("")).json.items).toHaveLength(3); // default limit
  for (const bad of ["?limit=0", "?limit=201", "?limit=abc", "?cursor=not-a-cursor", `?cursor=${btoa("9999-99-99 99:99:99+00|x")}`]) {
    expect((await get(bad)).status, bad).toBe(400);
  }
});

test("/ready answers 200 only when the database answers, while /health stays a pure liveness check", async () => {
  expect((await ctx.fetch(`/ready`)).status).toBe(200);

  const dead = await startServer({ port: 0, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), db: { ...ctx.db.db, ping: () => Promise.reject(new Error("connection refused")) } satisfies Db });
  try {
    expect((await fetch(`${dead.url}/health`)).status).toBe(200);
    const ready = await fetch(`${dead.url}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.text()).not.toMatch(/refused/);
  } finally {
    await dead.close();
  }
});
