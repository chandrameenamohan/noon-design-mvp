import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { ErrorBody } from "@noon/contracts";
import type { Db, Rule } from "@noon/db";
import { buildApp } from "./app.ts";
import { trustedProxies } from "./client-address.ts";
import { devHeaderIdentity } from "./identity.ts";

// E9.6's wiring against an in-memory limiter, so it runs in `make unit`: which key each request is charged to, and
// which requests are charged at all. The Postgres count itself (shared by instances, the window's end as Retry-After)
// is http-rate-limit.int.test.ts's.

const SESSIONS = { secret: "unit-only-session-secret-0123456789abcdef", sync: { kind: "one", url: "ws://sync.test:3001" } as const, ttlSeconds: 90 };
const tight = { limit: 2, windowSeconds: 60 };
const limits = { user: tight, address: tight, mint: { limit: 1, windowSeconds: 60 }, attempt: tight };

function app({ trust = "loopback" } = {}) {
  const hits = new Map<string, number>();
  const charged: string[] = [];
  const lookups: string[] = [];
  const db = {
    take: (key: string, rule: Rule) => {
      charged.push(key);
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return Promise.resolve(n <= rule.limit ? { ok: true } : { ok: false, retryAfterSeconds: 7 });
    },
    upsertUser: ({ email, name }: { email: string; name: string }) => Promise.resolve({ id: `id-${email}`, email, name }),
    listOrgsFor: () => Promise.resolve({ items: [], nextCursor: null }),
    getDocumentForMember: (id: string) => { lookups.push(id); return Promise.resolve(undefined); },
    ping: () => Promise.resolve(),
  };
  const hono = buildApp({ db: db as unknown as Db, identify: devHeaderIdentity, sessions: SESSIONS, enqueue: () => Promise.resolve(), limits, trustProxy: trustedProxies(trust), webhookSecret: "w".repeat(32), allowAttempt: () => Promise.resolve({ ok: true }) });
  /** `peer`: the socket's address, as @hono/node-server hands it over. */
  const call = (path: string, { method = "GET", headers = {}, peer }: { method?: string; headers?: Record<string, string>; peer?: string } = {}) =>
    hono.request(path, { method, headers }, peer === undefined ? undefined : { incoming: { socket: { remoteAddress: peer } } });
  return { call, charged, lookups };
}
const ann = { "x-dev-user": "ann@example.com" };

test("a known caller is charged per user, and over the limit is 429 with Retry-After and the same wait in the body", async () => {
  const { call, charged } = app();
  expect((await call("/orgs", { headers: ann })).status).toBe(200);
  expect((await call("/orgs", { headers: ann })).status).toBe(200);
  const refused = await call("/orgs", { headers: ann });
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("7");
  expect(ErrorBody.parse(await refused.json())).toEqual({ error: "rate_limited", retryAfterSeconds: 7 });
  expect((await call("/orgs", { headers: { "x-dev-user": "bob@example.com" } })).status).toBe(200); // another user, another count
  expect(charged).toEqual(["user:id-ann@example.com", "user:id-ann@example.com", "user:id-ann@example.com", "user:id-bob@example.com"]);
});

test("public routes and unrecognised callers are charged per client address: X-Forwarded-For only from a trusted peer", async () => {
  const { call, charged } = app();
  await call("/auth/me", { peer: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.1" } });
  await call("/auth/signout", { method: "POST", peer: "203.0.113.9", headers: { "x-forwarded-for": "198.51.100.2" } }); // not trusted: header ignored
  expect((await call("/orgs", { peer: "::ffff:203.0.113.9" })).status).toBe(401); // nobody: still counted, per address
  expect(charged).toEqual(["address:198.51.100.1", "address:203.0.113.9", "address:203.0.113.9"]);
  const refused = await call("/orgs", { peer: "203.0.113.9" });
  expect(refused.status).toBe(429); // over the limit, the 401 becomes a 429: guessing sessions is limited too
  expect(refused.headers.get("retry-after")).toBe("7");
  expect((await call("/orgs", { peer: "203.0.113.10" })).status).toBe(401);
});

test("private peers are proxies only when TRUST_PROXY says so (compose: loopback,private)", async () => {
  const { call, charged } = app({ trust: "loopback,private" });
  await call("/auth/me", { peer: "192.168.65.1", headers: { "x-forwarded-for": "198.51.100.1" } });
  expect(charged).toEqual(["address:198.51.100.1"]);
});

test("the probes and Gitea's webhook are never charged, however often they are called", async () => {
  const { call, charged } = app();
  for (let i = 0; i < 10; i++) {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/ready")).status).toBe(200);
    expect((await call("/webhooks/gitea", { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(401); // the HMAC, not a limit
  }
  expect(charged).toEqual([]);
});

test("minting a session has its own tighter limit, charged before the document is looked up", async () => {
  const { call, charged, lookups } = app();
  expect((await call("/documents/d1/session", { method: "POST", headers: ann })).status).toBe(404); // not theirs (a revoked share)
  const refused = await call("/documents/d1/session", { method: "POST", headers: ann });
  expect(refused.status).toBe(429);
  expect(ErrorBody.parse(await refused.json())).toEqual({ error: "rate_limited", retryAfterSeconds: 7 });
  expect(lookups).toEqual(["d1"]); // the refused one never reached the lookup
  expect(charged).toEqual(["user:id-ann@example.com", "mint:id-ann@example.com", "user:id-ann@example.com", "mint:id-ann@example.com"]);
  // Other document routes are not minting.
  charged.length = 0;
  await call("/documents/d1/run", { headers: { "x-dev-user": "bob@example.com" } });
  expect(charged).toEqual(["user:id-bob@example.com"]);
});

test("sign-in attempts default to the limiter, per route and email, under a hash of the key", async () => {
  const hits: string[] = [];
  const db = { take: (key: string) => { hits.push(key); return Promise.resolve({ ok: false, retryAfterSeconds: 3 }); } };
  const hono = buildApp({ db: db as unknown as Db, identify: devHeaderIdentity, sessions: SESSIONS, enqueue: () => Promise.resolve(), limits });
  const res = await hono.request("/auth/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "Ann@Example.com", password: "x" }) });
  // The address was asked first (and refused here too): the per-address answer comes before the body is read.
  expect(res.status).toBe(429);
  expect(hits).toEqual(["address:unknown"]);
  const allowAddress = { take: (key: string) => { hits.push(key); return Promise.resolve(key.startsWith("address:") ? { ok: true } : { ok: false, retryAfterSeconds: 3 }); } };
  hits.length = 0;
  const again = await buildApp({ db: allowAddress as unknown as Db, identify: devHeaderIdentity, sessions: SESSIONS, enqueue: () => Promise.resolve(), limits })
    .request("/auth/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "Ann@Example.com", password: "x" }) });
  expect(again.status).toBe(429);
  expect(ErrorBody.parse(await again.json())).toEqual({ error: "too_many_attempts", retryAfterSeconds: 3 });
  expect(hits).toEqual(["address:unknown", `attempt:${createHash("sha256").update("signin:ann@example.com").digest("hex")}`]);
});
