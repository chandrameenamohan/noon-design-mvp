import { describe, expect, test } from "vitest";
import { Document, ErrorBody, Member, Org, SessionResponse, Workspace } from "@noon/contracts";
import { buildApp } from "./app.ts";
import { trustedProxies } from "./client-address.ts";
import { devHeaderIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { TEST_SESSIONS, useTestServer } from "./testing.ts";

// E9.6 (F31), against real Postgres and a real socket. Every route but the probes and Gitea's webhook is counted:
// per user when the caller is known, per client address otherwise (X-Forwarded-For believed only from a loopback
// peer, which is what these requests come from). Over the limit: 429, Retry-After = the window's end by the
// database's clock, the same number in the body. Minting a sync session has its own, tighter count.
const WINDOW = 3600;
const limits = {
  user: { limit: 8, windowSeconds: WINDOW },
  address: { limit: 3, windowSeconds: WINDOW },
  mint: { limit: 2, windowSeconds: WINDOW },
  attempt: { limit: 2, windowSeconds: WINDOW },
  signinBrake: { limit: 5, windowSeconds: WINDOW },
};
const ctx = useTestServer({ limits, trustProxy: trustedProxies("loopback") });

const as = (user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  ctx.fetch(path, { method, headers: { "x-dev-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
/** A request with no caller at all: from the address `forwardedFor` names (believed: the peer is loopback). */
const anonymous = (path: string, forwardedFor: string, init: RequestInit = {}) =>
  fetch(`${ctx.server.url}${path}`, { ...init, headers: { "x-forwarded-for": forwardedFor, ...(init.headers as Record<string, string> | undefined) } });
/** Seconds to the end of the current window by the DATABASE's clock (the one the limiter reads). */
const secondsLeft = async (): Promise<number> =>
  Number(((await ctx.db.rawQuery("select ($1::float8 - mod(extract(epoch from clock_timestamp()), $1::float8::numeric)::float8) as remaining", [WINDOW])) as { rows: { remaining: number }[] }).rows[0]?.remaining);
async function expectLimited(res: Response, error: "rate_limited" | "too_many_attempts" = "rate_limited"): Promise<void> {
  expect(res.status).toBe(429);
  const retry = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retry)).toBe(true);
  expect(Math.abs(retry - (await secondsLeft()))).toBeLessThanOrEqual(2); // measured a moment later, rounded up
  expect(ErrorBody.parse(await res.json())).toEqual({ error, retryAfterSeconds: retry });
}

describe("integration:http-rate-limit-429-retry-after", () => {
  test("a user's requests are counted across every route and every api instance: the ninth is 429 with the window's end", async () => {
    const other = buildApp({ db: ctx.db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), limits });
    const statuses = await Promise.all([
      as("ann@example.com", "GET", "/orgs"),
      as("ann@example.com", "GET", "/orgs"),
      as("ann@example.com", "GET", "/orgs"),
      as("ann@example.com", "POST", "/orgs", { name: "Ann's" }),
      other.request("/orgs", { headers: { "x-dev-user": "ann@example.com" } }),
      other.request("/orgs", { headers: { "x-dev-user": "ann@example.com" } }),
      other.request("/orgs", { headers: { "x-dev-user": "ann@example.com" } }),
      as("ann@example.com", "GET", "/documents/00000000-0000-4000-8000-000000000000/run"), // a 404 costs a request too
    ].map(async (res) => (await res).status));
    expect(statuses.sort()).toEqual([200, 200, 200, 200, 200, 200, 201, 404]);
    await expectLimited(await as("ann@example.com", "GET", "/orgs"));
    await expectLimited(await other.request("/orgs", { headers: { "x-dev-user": "ann@example.com" } }));
    // Another user has their own count.
    expect((await as("bob@example.com", "GET", "/orgs")).status).toBe(200);
  });

  test("public routes are counted per client address, and so is a caller nobody recognises", async () => {
    expect((await anonymous("/auth/me", "198.51.100.1")).status).toBe(200);
    expect((await anonymous("/orgs", "198.51.100.1")).status).toBe(401);
    expect((await anonymous("/auth/signout", "198.51.100.1", { method: "POST" })).status).toBe(204);
    await expectLimited(await anonymous("/auth/me", "198.51.100.1"));
    await expectLimited(await anonymous("/orgs", "198.51.100.1")); // guessing sessions is limited like the rest
    // Another client behind the same proxy is another address.
    expect((await anonymous("/auth/me", "198.51.100.2")).status).toBe(200);
    // What the client writes LEFT of the proxy's own entry is not believed: still 198.51.100.1.
    await expectLimited(await anonymous("/auth/me", "203.0.113.50, 198.51.100.1"));
  });

  test("an untrusted peer's X-Forwarded-For is ignored: changing it does not buy a fresh count", async () => {
    // A real socket, so there IS a peer (loopback, trusted by nobody here).
    const server = await startServer({ port: 0, db: ctx.db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), limits, trustProxy: trustedProxies("") });
    try {
      const statuses = [];
      for (const xff of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]) statuses.push((await fetch(`${server.url}/auth/me`, { headers: { "x-forwarded-for": xff } })).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      await server.close();
    }
  });

  test("sign-in is limited per email and address, with a retry time; another address's guesses do not lock the owner out", async () => {
    expect((await anonymous("/auth/signup", "198.51.100.10", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "cat@example.com", name: "Cat", password: "correct horse battery" }) })).status).toBe(201);
    const signIn = (from: string, password = "wrong wrong wrong") => anonymous("/auth/signin", from, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "CAT@example.com", password }) });
    expect((await signIn("198.51.100.11")).status).toBe(401);
    expect((await signIn("198.51.100.11")).status).toBe(401);
    await expectLimited(await signIn("198.51.100.11"), "too_many_attempts"); // the third request: the address limit (3) still has room
    expect((await signIn("198.51.100.12", "correct horse battery")).status).toBe(200);
    // Spread over addresses, guesses meet the per-email brake (5): 2 + 1 above, 2 more here, then refused. A guess the
    // per-address count refused charged nothing, or the second one here would already be.
    expect((await signIn("198.51.100.13")).status).toBe(401);
    expect((await signIn("198.51.100.13")).status).toBe(401);
    await expectLimited(await signIn("198.51.100.14"), "too_many_attempts");
  });

  test("the probes and Gitea's webhook are never limited into failure", async () => {
    for (let i = 0; i < limits.address.limit * 3; i++) {
      expect((await anonymous("/health", "198.51.100.20")).status).toBe(200);
      expect((await anonymous("/ready", "198.51.100.20")).status).toBe(200);
      // Unsigned: the HMAC refuses it (401), never the limiter. TEST_WEBHOOK_SECRET is set on this server.
      expect((await anonymous("/webhooks/gitea", "198.51.100.20", { method: "POST", headers: { "content-type": "application/json", "x-gitea-event": "push" }, body: "{}" })).status).toBe(401);
    }
    // Nothing was charged to that address.
    expect((await anonymous("/auth/me", "198.51.100.20")).status).toBe(200);
  });
});

describe("integration:session-mint-limit", () => {
  test("a revoked collaborator who keeps minting is refused with a retry time, on a count of its own; the owner is untouched", async () => {
    // The mint count (2) is tighter than the per-user one (8): the guest's third mint is refused with requests to spare.
    const owner = "own@example.com";
    const guest = "guest@example.com";
    const org = Org.parse(await (await as(owner, "POST", "/orgs", { name: "Mint" })).json());
    const ws = Workspace.parse(await (await as(owner, "POST", `/orgs/${org.id}/workspaces`, { name: "w" })).json());
    const doc = Document.parse(await (await as(owner, "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Page" })).json());
    expect((await as(guest, "GET", "/orgs")).status).toBe(200); // the guest exists (the dev header makes them on first sight)
    const share = Member.parse(await (await as(owner, "PUT", `/documents/${doc.id}/shares`, { email: guest, role: "editor" })).json());

    SessionResponse.parse(await (await as(guest, "POST", `/documents/${doc.id}/session`)).json());
    expect((await as(owner, "DELETE", `/documents/${doc.id}/shares/${share.userId}`)).status).toBe(204);
    expect((await as(guest, "POST", `/documents/${doc.id}/session`)).status).toBe(404); // revoked: counted all the same
    await expectLimited(await as(guest, "POST", `/documents/${doc.id}/session`));
    await expectLimited(await as(guest, "POST", `/documents/${doc.id}/session`)); // refusals do not stretch the wait (the window's end)

    // The owner mints on their own count (their sixth request, under the per-user eight).
    SessionResponse.parse(await (await as(owner, "POST", `/documents/${doc.id}/session`)).json());
  });
});
