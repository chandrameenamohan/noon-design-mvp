import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ErrorBody, Me, Org, User } from "@noon/contracts";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../../../packages/db/src/testing.ts";
import { sessionIdentity } from "./identity.ts";
import { startServer, type RunningServer } from "./server.ts";
import { TEST_SESSIONS, useApiProcess } from "./testing.ts";

// E8.1 (F23). Real Postgres; the api with the strategy every non-development process gets.
let t: TestDb, api: RunningServer;
beforeAll(async () => {
  t = await createTestDb();
  api = await startServer({ port: 0, db: t.db, identify: sessionIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), signIn: { ttlSeconds: 3600, secureCookie: true } });
});
afterAll(async () => {
  await api.close();
  await t.drop();
});

const call = (base: string, method: string, path: string, { body, cookie, headers = {} }: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const cookieOf = (res: Response) => /^(noon_session=[^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
const rows = async <T,>(sql: string, params: unknown[] = []) => ((await t.rawQuery(sql, params)) as { rows: T[] }).rows;

describe("integration:auth-flows", () => {
  test("sign up, work as that user, sign out, sign back in: the whole loop against Postgres", async () => {
    const up = await call(api.url, "POST", "/auth/signup", { body: { email: "Flow@Example.com", name: "Flo", password: "correct horse battery" } });
    expect(up.status).toBe(201);
    const flo = User.parse(await up.json());
    const cookie = cookieOf(up);

    const org = Org.parse(await (await call(api.url, "POST", "/orgs", { body: { name: "Flo's org" }, cookie })).json());
    expect((await call(api.url, "GET", "/orgs", { cookie })).status).toBe(200);
    expect(await rows("select user_id, role from memberships where org_id = $1", [org.id])).toEqual([{ user_id: flo.id, role: "owner" }]);

    expect((await call(api.url, "POST", "/auth/signout", { cookie })).status).toBe(204);
    expect((await call(api.url, "GET", "/orgs", { cookie })).status).toBe(401);

    const back = await call(api.url, "POST", "/auth/signin", { body: { email: "flow@example.com", password: "correct horse battery" } });
    expect(back.status).toBe(200);
    expect(User.parse(await back.json())).toEqual(flo);
    expect((await (await call(api.url, "GET", "/orgs", { cookie: cookieOf(back) })).json())).toMatchObject({ items: [org] });
  });

  test("what Postgres keeps: a scrypt hash, never the password; a token's SHA-256, never the token", async () => {
    const up = await call(api.url, "POST", "/auth/signup", { body: { email: "stored@example.com", name: "S", password: "hunter2-hunter2" } });
    const user = User.parse(await up.json());
    const token = cookieOf(up).slice("noon_session=".length);
    const [cred] = await rows<{ password_hash: string }>("select password_hash from credentials where user_id = $1", [user.id]);
    expect(cred?.password_hash).toMatch(/^scrypt\$/);
    expect(cred?.password_hash).not.toContain("hunter2");
    const sessions = await rows<{ token_hash: Buffer; ttl: number }>("select token_hash, extract(epoch from expires_at - created_at)::int as ttl from auth_sessions where user_id = $1", [user.id]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.token_hash.toString("base64url")).not.toBe(token);
    expect(sessions[0]?.ttl).toBe(3600); // the configured lifetime, not a hardcoded one
  });

  test("an unknown email, a wrong password and a user who never set one (the dev header's) get one answer", async () => {
    await call(api.url, "POST", "/auth/signup", { body: { email: "real@example.com", name: "R", password: "correct horse battery" } });
    await t.db.upsertUser({ email: "headeronly@example.com", name: "h" });
    const answers = await Promise.all([
      call(api.url, "POST", "/auth/signin", { body: { email: "ghost@example.com", password: "correct horse battery" } }),
      call(api.url, "POST", "/auth/signin", { body: { email: "real@example.com", password: "wrong horse battery" } }),
      call(api.url, "POST", "/auth/signin", { body: { email: "headeronly@example.com", password: "" } }),
    ]);
    const texts = await Promise.all(answers.map((res) => res.text()));
    expect(answers.map((res) => res.status)).toEqual([401, 401, 401]);
    expect(new Set(texts)).toEqual(new Set([JSON.stringify({ error: "invalid_credentials" })]));
    expect(answers.map((res) => res.headers.get("set-cookie"))).toEqual([null, null, null]);
  });

  test("an email already in use (a signed-up user, a dev-header user, a sign-up racing another) is 409; exactly one account exists", async () => {
    await t.db.upsertUser({ email: "early@example.com", name: "e" });
    expect((await call(api.url, "POST", "/auth/signup", { body: { email: "early@example.com", name: "E", password: "correct horse battery" } })).status).toBe(409);
    expect(await rows("select 1 from credentials c join users u on u.id = c.user_id where u.email = 'early@example.com'")).toEqual([]);

    const race = await Promise.all([1, 2, 3, 4].map((i) => call(api.url, "POST", "/auth/signup", { body: { email: "race@example.com", name: `R${String(i)}`, password: `password-${String(i)}` } })));
    expect(race.map((res) => res.status).sort()).toEqual([201, 409, 409, 409]);
    expect(ErrorBody.parse(await race.find((res) => res.status === 409)?.json())).toEqual({ error: "email_taken" });
    expect(await rows("select count(*)::int as n from users u join credentials c on c.user_id = u.id where u.email = 'race@example.com'")).toEqual([{ n: 1 }]);
  });

  test("an expired session no longer authenticates, and a new sign-in sweeps that user's expired rows", async () => {
    const up = await call(api.url, "POST", "/auth/signup", { body: { email: "expiry@example.com", name: "X", password: "correct horse battery" } });
    const user = User.parse(await up.json());
    await t.rawQuery("update auth_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where user_id = $1", [user.id]);
    expect((await call(api.url, "GET", "/orgs", { cookie: cookieOf(up) })).status).toBe(401);
    await call(api.url, "POST", "/auth/signin", { body: { email: "expiry@example.com", password: "correct horse battery" } });
    expect(await rows("select count(*)::int as n from auth_sessions where user_id = $1", [user.id])).toEqual([{ n: 1 }]);
  });

  test("a session belongs to one user: another user's orgs stay 404 with it", async () => {
    const a = cookieOf(await call(api.url, "POST", "/auth/signup", { body: { email: "a-tenant@example.com", name: "A", password: "correct horse battery" } }));
    const b = cookieOf(await call(api.url, "POST", "/auth/signup", { body: { email: "b-tenant@example.com", name: "B", password: "correct horse battery" } }));
    const org = Org.parse(await (await call(api.url, "POST", "/orgs", { body: { name: "A only" }, cookie: a })).json());
    expect((await call(api.url, "GET", `/orgs/${org.id}`, { cookie: b })).status).toBe(404);
    expect((await call(api.url, "GET", `/orgs/${org.id}`, { cookie: a })).status).toBe(200);
  });
});

// The REAL entry point in a REAL process, as main.int.test.ts does: a test that hands startServer a strategy
// cannot prove main.ts wires the right one.
describe("integration:dev-header-no-longer-authenticates", () => {
  const spawnApi = useApiProcess();
  // This file's own migrated schema (libpq's options in the URL), so the child sees the sign-in tables whatever
  // state the shared database is in, and every row it writes goes when the schema is dropped.
  const boot = async (env: Record<string, string>): Promise<string> =>
    (await spawnApi({ DATABASE_URL: `${TEST_DATABASE_URL}${TEST_DATABASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${t.schema}`)}`, ...env })).url;

  test.each([["unset", {}], ["production", { NODE_ENV: "production" }], ["test", { NODE_ENV: "test" }]])(
    "with NODE_ENV %s the header is 401 on every route, and signing in is the way in",
    async (_label, env) => {
      const url = await boot(env);
      const header = { "x-dev-user": "header-user@example.com" };
      expect(await (await call(url, "GET", "/auth/me", { headers: header })).json()).toEqual({ user: null });
      for (const [method, path] of [["GET", "/orgs"], ["POST", "/orgs"], ["POST", "/documents/00000000-0000-4000-8000-000000000000/session"]] as const) {
        const res = await call(url, method, path, { headers: header, ...(method === "POST" && path === "/orgs" ? { body: { name: "x" } } : {}) });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      const email = `main-${String(Date.now())}-${String(Math.random()).slice(2, 8)}@example.com`;
      const up = await call(url, "POST", "/auth/signup", { body: { email, name: "Main", password: "correct horse battery" } });
      expect(up.status).toBe(201);
      expect(up.headers.get("set-cookie")).toContain("Secure");
      // With a session AND someone else's header, the session decides: the header is not even a tiebreak.
      const me = Me.parse(await (await call(url, "GET", "/auth/me", { cookie: cookieOf(up), headers: header })).json());
      expect(me.user?.email).toBe(email);
    },
  );

  test("with NODE_ENV=development the header still works (scripts, the tunnel demo), and a session outranks it", async () => {
    const url = await boot({ NODE_ENV: "development" });
    expect(Me.parse(await (await call(url, "GET", "/auth/me", { headers: { "x-dev-user": "dev-main@example.com" } })).json()).user?.email).toBe("dev-main@example.com");
    const email = `dev-${String(Date.now())}@example.com`;
    const up = await call(url, "POST", "/auth/signup", { body: { email, name: "Dev", password: "correct horse battery" } });
    expect(up.headers.get("set-cookie")).not.toContain("Secure"); // plain http: a Secure cookie would never come back
    expect(Me.parse(await (await call(url, "GET", "/auth/me", { cookie: cookieOf(up), headers: { "x-dev-user": "dev-main@example.com" } })).json()).user?.email).toBe(email);
  });
});
