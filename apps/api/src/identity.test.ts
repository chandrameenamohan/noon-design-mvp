import { Hono } from "hono";
import { expect, test } from "vitest";
import type { Db } from "@noon/db";
import { chooseIdentity, devHeaderIdentity, SESSION_COOKIE, sessionIdentity } from "./identity.ts";
import { newSessionToken } from "./password.ts";

const ann = { id: "11111111-1111-4111-8111-111111111111", email: "ann@example.com", name: "Ann" };
const dev = { id: "33333333-3333-4333-8333-333333333333", email: "dev@example.com", name: "dev" };
const signedIn = newSessionToken();

/** A Db that knows one session and records what it was asked: enough to see which strategy did what. */
function fakeDb() {
  const asked: string[] = [];
  const db = {
    userForSession: (hash: Buffer) => { asked.push("session"); return Promise.resolve(hash.equals(signedIn.hash) ? ann : undefined); },
    upsertUser: () => { asked.push("upsert"); return Promise.resolve(dev); },
  } as unknown as Db;
  return { db, asked };
}
async function who(nodeEnv: "development" | "test" | "production", headers: Record<string, string>) {
  const { db, asked } = fakeDb();
  const app = new Hono().get("/", async (c) => c.json((await chooseIdentity(nodeEnv)(c, db)) ?? null));
  return { user: (await (await app.request("/", { headers })).json()) as unknown, asked };
}
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

test("outside development ONLY a sign-in session identifies the caller: the dev header is ignored, never looked at", async () => {
  for (const env of ["production", "test"] as const) {
    expect(chooseIdentity(env)).toBe(sessionIdentity);
    expect(await who(env, { "x-dev-user": "ann@example.com" }), env).toEqual({ user: null, asked: [] });
    expect((await who(env, cookie(signedIn.token))).user, env).toEqual(ann);
    expect((await who(env, { ...cookie(newSessionToken().token), "x-dev-user": "dev@example.com" })).user, env).toBeNull();
  }
});

test("a session lookup is a pure read, and a malformed cookie never reaches the database", async () => {
  expect((await who("production", cookie(signedIn.token))).asked).toEqual(["session"]);
  for (const bad of ["", "short", `${signedIn.token}x`, "a'; drop table users; --"]) expect((await who("production", cookie(bad))).asked, bad).toEqual([]);
});

test("in development a session wins over the header, and the header works when there is no session", async () => {
  expect(chooseIdentity("development")).not.toBe(devHeaderIdentity);
  expect(await who("development", { ...cookie(signedIn.token), "x-dev-user": "dev@example.com" })).toEqual({ user: ann, asked: ["session"] });
  expect((await who("development", { "x-dev-user": "dev@example.com" })).user).toEqual(dev);
  expect((await who("development", {})).user).toBeNull();
});
