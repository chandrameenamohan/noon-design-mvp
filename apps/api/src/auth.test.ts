import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ErrorBody, Me, User } from "@noon/contracts";
import type { Db } from "@noon/db";
import { buildApp, type AppDeps } from "./app.ts";
import { sessionIdentity } from "./identity.ts";

// E8.1's route logic against an in-memory store, so it runs in `make unit`. auth.int.test.ts runs the same
// flows against real Postgres and the real entry point.

// Not testing.ts's: importing it needs Postgres. No route here opens a live session.
const SESSIONS = { secret: "unit-only-session-secret-0123456789abcdef", sync: { kind: "one", url: "ws://sync.test:3001" } as const, ttlSeconds: 90 };

function memoryDb() {
  const users = new Map<string, { user: User; passwordHash: string }>();
  const sessions = new Map<string, { userId: string; expires: number }>();
  const calls: string[] = [];
  const db = {
    signUp: ({ email, name, passwordHash }: { email: string; name: string; passwordHash: string }) => {
      calls.push("signUp");
      const key = email.toLowerCase();
      if (users.has(key)) return Promise.resolve("taken" as const);
      const user = { id: randomUUID(), email: key, name };
      users.set(key, { user, passwordHash });
      return Promise.resolve(user);
    },
    credentialsFor: (email: string) => { calls.push("credentialsFor"); return Promise.resolve(users.get(email.toLowerCase())); },
    startSession: ({ userId, tokenHash, ttlSeconds }: { userId: string; tokenHash: Buffer; ttlSeconds: number }) => {
      sessions.set(tokenHash.toString("hex"), { userId, expires: Date.now() + ttlSeconds * 1000 });
      return Promise.resolve();
    },
    userForSession: (tokenHash: Buffer) => {
      const s = sessions.get(tokenHash.toString("hex"));
      return Promise.resolve(s && s.expires > Date.now() ? [...users.values()].find((u) => u.user.id === s.userId)?.user : undefined);
    },
    endSession: (tokenHash: Buffer) => { sessions.delete(tokenHash.toString("hex")); return Promise.resolve(); },
    listOrgsFor: () => Promise.resolve({ items: [], nextCursor: null }),
    take: () => Promise.resolve({ ok: true }), // the limits themselves: http-limits.test.ts
  };
  return { db: db as unknown as Db, sessions, calls };
}

function app(deps: Partial<AppDeps> = {}) {
  const store = memoryDb();
  const hono = buildApp({ db: store.db, identify: sessionIdentity, sessions: SESSIONS, enqueue: () => Promise.resolve(), signIn: { ttlSeconds: 3600, secureCookie: true }, ...deps });
  const post = (path: string, body?: unknown, cookie?: string) =>
    hono.request(path, { method: "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = (path: string, headers: Record<string, string> = {}) => hono.request(path, { headers });
  return { store, post, get };
}
const ann = { email: "Ann@Example.com", name: "Ann", password: "correct horse battery" };
/** `noon_session=<token>` from a Set-Cookie header: what the browser would send back. */
const cookieOf = (res: Response) => /^(noon_session=[^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

test("sign up answers 201 with the user and an HttpOnly, SameSite=Strict, Secure cookie that authenticates the next request", async () => {
  const { post, get, store } = app();
  const res = await post("/auth/signup", ann);
  expect(res.status).toBe(201);
  const user = User.parse(await res.json());
  expect(user).toMatchObject({ email: "ann@example.com", name: "Ann" });
  expect(JSON.stringify(user)).not.toContain("scrypt");
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^noon_session=[A-Za-z0-9_-]{43}; /);
  for (const attribute of ["Max-Age=3600", "Path=/", "HttpOnly", "Secure", "SameSite=Strict"]) expect(setCookie).toContain(attribute);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // The store holds the token's hash, never the token.
  expect([...store.sessions.keys()].join()).not.toContain(cookieOf(res).slice("noon_session=".length));

  expect(Me.parse(await (await get("/auth/me", { cookie: cookieOf(res) })).json())).toEqual({ user });
  expect((await get("/orgs", { cookie: cookieOf(res) })).status).toBe(200);
});

test("without a session every route but the probes and the three sign-in routes is 401, and the dev header changes nothing", async () => {
  const { get, post } = app();
  expect((await get("/orgs")).status).toBe(401);
  expect((await get("/orgs", { "x-dev-user": "ann@example.com" })).status).toBe(401);
  expect((await get("/orgs", { cookie: "noon_session=not-a-token" })).status).toBe(401);
  expect((await post("/documents/00000000-0000-4000-8000-000000000000/session")).status).toBe(401);
  expect(ErrorBody.parse(await (await get("/orgs")).json()).error).toBe("unauthenticated");
  // Asking who you are is not an error when you are nobody: a signed-out home page must not log a 401.
  const me = await get("/auth/me", { "x-dev-user": "ann@example.com" });
  expect(me.status).toBe(200);
  expect(await me.json()).toEqual({ user: null });
});

test("a second sign-up with the same email, in any case, is 409 and sets no cookie", async () => {
  const { post } = app();
  await post("/auth/signup", ann);
  const again = await post("/auth/signup", { ...ann, email: "ANN@example.com", password: "another password" });
  expect(again.status).toBe(409);
  expect(ErrorBody.parse(await again.json())).toEqual({ error: "email_taken" });
  expect(again.headers.get("set-cookie")).toBeNull();
});

test.each([[{ ...ann, password: "short" }], [{ ...ann, email: "not-an-email" }], [{ ...ann, name: `An${String.fromCharCode(0x202e)}n` }], [{ ...ann, role: "owner" }], [{ email: ann.email, password: ann.password }]])(
  "a sign-up body that breaks the contract (%j) is 400 before anything is hashed or stored",
  async (body) => {
    const { post, store } = app();
    expect((await post("/auth/signup", body)).status).toBe(400);
    expect(store.calls).toEqual([]);
  },
);

test("an unknown email and a wrong password get the same answer, byte for byte, and neither sets a cookie", async () => {
  const { post } = app();
  await post("/auth/signup", ann);
  const unknown = await post("/auth/signin", { email: "nobody@example.com", password: ann.password });
  const wrong = await post("/auth/signin", { email: ann.email, password: "wrong horse battery" });
  const notAnEmail = await post("/auth/signin", { email: "nobody", password: "x" });
  for (const res of [unknown, wrong, notAnEmail]) {
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  }
  const [a, b, c] = await Promise.all([unknown.text(), wrong.text(), notAnEmail.text()]);
  expect(a).toBe(JSON.stringify({ error: "invalid_credentials" }));
  expect(b).toBe(a);
  expect(c).toBe(a);
  expect([...unknown.headers.entries()]).toEqual([...wrong.headers.entries()]);
});

test("an unknown email costs a password hash too: its answer is not measurably faster than a wrong password's", async () => {
  const { post } = app();
  await post("/auth/signup", ann);
  const time = async (email: string) => {
    const started = performance.now();
    await post("/auth/signin", { email, password: "wrong horse battery" });
    return performance.now() - started;
  };
  await time("warm@example.com");
  const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
  const unknown: number[] = [];
  const wrong: number[] = [];
  for (let i = 0; i < 5; i++) {
    unknown.push(await time(`nobody-${String(i)}@example.com`));
    wrong.push(await time(ann.email));
  }
  // Without the dummy hash the unknown email answers in well under a millisecond, the other in tens of them.
  expect(median(unknown)).toBeGreaterThan(median(wrong) * 0.3);
});

test("signing in starts a NEW session: a different cookie from sign-up's, and both work until signed out", async () => {
  const { post, get } = app();
  const first = cookieOf(await post("/auth/signup", ann));
  const res = await post("/auth/signin", { email: "ann@example.com", password: ann.password });
  expect(res.status).toBe(200);
  expect(User.parse(await res.json()).email).toBe("ann@example.com");
  const second = cookieOf(res);
  expect(second).not.toBe(first);
  expect((await get("/orgs", { cookie: first })).status).toBe(200);
  expect((await get("/orgs", { cookie: second })).status).toBe(200);
});

test("sign-out revokes that session at once and clears the cookie; the other session stays; signing out again is fine", async () => {
  const { post, get } = app();
  const kept = cookieOf(await post("/auth/signup", ann));
  const ended = cookieOf(await post("/auth/signin", { email: ann.email, password: ann.password }));
  const out = await post("/auth/signout", undefined, ended);
  expect(out.status).toBe(204);
  expect(out.headers.get("set-cookie")).toMatch(/^noon_session=; Max-Age=0; /);
  // A copy of the token (another tab, a stolen cookie) is dead on its next request.
  expect((await get("/orgs", { cookie: ended })).status).toBe(401);
  expect((await get("/orgs", { cookie: kept })).status).toBe(200);
  expect((await post("/auth/signout", undefined, ended)).status).toBe(204);
  expect((await post("/auth/signout")).status).toBe(204);
});

test("a session past its lifetime no longer authenticates", async () => {
  const { post, get } = app({ signIn: { ttlSeconds: 0.05, secureCookie: true } });
  const cookie = cookieOf(await post("/auth/signup", ann));
  await new Promise((r) => setTimeout(r, 80));
  expect((await get("/orgs", { cookie })).status).toBe(401);
});

test("the rate-limit seam is asked with the route and the email (and, signing in, the address); a no is 429 with its wait, before any hash or lookup", async () => {
  const asked: string[] = [];
  const { post, store } = app({ allowAttempt: (key) => { asked.push(key); return Promise.resolve({ ok: false, retryAfterSeconds: 42 }); } });
  const up = await post("/auth/signup", ann);
  const into = await post("/auth/signin", { email: ann.email, password: ann.password });
  for (const res of [up, into]) {
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(ErrorBody.parse(await res.json())).toEqual({ error: "too_many_attempts", retryAfterSeconds: 42 });
  }
  expect(asked).toEqual(["signup:ann@example.com", "signin:ann@example.com:unknown"]); // no socket here: no address
  expect(store.calls).toEqual([]);
});

test("in development (plain http) the cookie is not Secure, or the browser would never send it back", async () => {
  const { post } = app({ signIn: { ttlSeconds: 3600, secureCookie: false } });
  expect((await post("/auth/signup", ann)).headers.get("set-cookie")).not.toContain("Secure");
});
