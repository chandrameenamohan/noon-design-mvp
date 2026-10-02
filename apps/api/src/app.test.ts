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
// noon-dtf.2.1: the table is EVERY route the app answers, not only those under /orgs/:orgId and /documents/:id, and a
// route without a `need` is the string "none", never a missing value (toEqual skips a key whose value is undefined, so
// an unguarded route used to pass). A new route anywhere must be added here, at its role or as "none", to pass.
test("every route the app answers is in this table, and every org and document route declares the role it needs", () => {
  const app = buildApp({ db: {} as Db, identify: () => Promise.resolve(undefined), sessions: { secret: "unused-in-this-test-0123456789abcdef", sync: { kind: "one", url: "ws://sync.test" }, ttlSeconds: 60 }, enqueue: () => Promise.resolve() });
  const guarded = new Map<string, string>();
  for (const { method, path, handler } of app.routes) {
    if (method === "ALL") continue; // middleware (app.use): it answers nothing of its own
    const key = `${method} ${path}`;
    const role = GUARDS.get(handler);
    if (role !== undefined || !guarded.has(key)) guarded.set(key, role ?? "none");
  }
  const scoped = [...guarded].filter(([key]) => /^[A-Z]+ \/(orgs\/:orgId|documents\/:id)(\/|$)/.test(key));
  expect(scoped.filter(([, role]) => role === "none")).toEqual([]); // an org or document route without a role is open to everyone
  expect(Object.fromEntries(guarded)).toStrictEqual({
    // Not about one org or document: the probes, Gitea's webhook (its HMAC is its gate), signing in and out, and the
    // caller's own orgs (GET /orgs lists only theirs). Everything but the probes, the webhook and /auth needs a caller.
    "GET /health": "none",
    "GET /ready": "none",
    "POST /webhooks/gitea": "none",
    "POST /auth/signup": "none",
    "POST /auth/signin": "none",
    "POST /auth/signout": "none",
    "GET /auth/me": "none",
    "POST /orgs": "none",
    "GET /orgs": "none",
    "GET /orgs/:orgId": "viewer",
    "GET /orgs/:orgId/members": "viewer",
    "PUT /orgs/:orgId/members": "owner",
    "POST /orgs/:orgId/workspaces": "editor",
    "GET /orgs/:orgId/workspaces": "viewer",
    "GET /orgs/:orgId/workspaces/:id": "viewer",
    "POST /orgs/:orgId/workspaces/:id/documents": "editor",
    "GET /orgs/:orgId/workspaces/:id/documents": "viewer",
    "GET /orgs/:orgId/documents/:id": "viewer",
    "GET /orgs/:orgId/usage": "owner",
    "GET /orgs/:orgId/audit": "owner",
    "POST /documents/:id/session": "viewer",
    "GET /documents/:id/shares": "owner",
    "PUT /documents/:id/shares": "owner",
    "DELETE /documents/:id/shares/:userId": "owner",
    "POST /documents/:id/runs": "editor",
    "POST /documents/:id/runs/:runId/cancel": "editor",
    "GET /documents/:id/runs/:runId": "viewer",
    "GET /documents/:id/run": "viewer",
    "POST /documents/:id/preview": "viewer",
    "GET /documents/:id/preview": "viewer",
    "GET /documents/:id/conflict": "viewer",
    "POST /documents/:id/ship": "editor",
    "GET /documents/:id/ship": "viewer",
  });
});
