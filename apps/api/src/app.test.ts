import { expect, test } from "vitest";
import type { Db } from "@noon/db";
import { buildApp, GUARDS, publicPreview } from "./app.ts";

const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";
const stored = `http://127.0.0.1:20000/preview/${doc}/0123456789abcdef.0123456789abcdef0123456789abcdef/noon-preview/?doc=${doc}&started=17`;

test("behind one public URL the preview is the same path and query on the public origin", () => {
  expect(publicPreview({ status: "running", url: stored }, "https://noon.example.com")).toEqual({
    status: "running",
    url: `https://noon.example.com/preview/${doc}/0123456789abcdef.0123456789abcdef0123456789abcdef/noon-preview/?doc=${doc}&started=17`,
  });
});

test("without one, or without a URL, the preview is what was stored", () => {
  expect(publicPreview({ status: "running", url: stored }, undefined)).toEqual({ status: "running", url: stored });
  expect(publicPreview({ status: "running", url: null }, "https://noon.example.com")).toEqual({ status: "running", url: null });
});

// E8.2 (F24): default deny. Every route about one org or one document names the least role it needs, and this is
// the table of them: a new route without a `need` fails here, and so does a role changed without anyone meaning to.
test("every org and document route declares the role it needs, and they are these", () => {
  const app = buildApp({ db: {} as Db, identify: () => Promise.resolve(undefined), sessions: { secret: "unused-in-this-test-0123456789abcdef", sync: { kind: "one", url: "ws://sync.test" }, ttlSeconds: 60 }, enqueue: () => Promise.resolve() });
  const guarded = new Map<string, string | undefined>();
  for (const { method, path, handler } of app.routes) {
    if (method === "ALL" || !/^\/(orgs\/:orgId|documents\/:id)(\/|$)/.test(path)) continue;
    const key = `${method} ${path}`;
    guarded.set(key, guarded.get(key) ?? GUARDS.get(handler));
  }
  expect(Object.fromEntries(guarded)).toEqual({
    "GET /orgs/:orgId": "viewer",
    "PUT /orgs/:orgId/members": "owner",
    "POST /orgs/:orgId/workspaces": "editor",
    "GET /orgs/:orgId/workspaces": "viewer",
    "GET /orgs/:orgId/workspaces/:id": "viewer",
    "POST /orgs/:orgId/workspaces/:id/documents": "editor",
    "GET /orgs/:orgId/workspaces/:id/documents": "viewer",
    "GET /orgs/:orgId/documents/:id": "viewer",
    "GET /orgs/:orgId/usage": "owner",
    "POST /documents/:id/session": "viewer",
    "PUT /documents/:id/shares": "owner",
    "DELETE /documents/:id/shares/:userId": "owner",
    "POST /documents/:id/runs": "editor",
    "POST /documents/:id/runs/:runId/cancel": "editor",
    "GET /documents/:id/runs/:runId": "viewer",
    "POST /documents/:id/preview": "viewer",
    "GET /documents/:id/preview": "viewer",
    "GET /documents/:id/conflict": "viewer",
    "POST /documents/:id/ship": "editor",
    "GET /documents/:id/ship": "viewer",
  });
});
