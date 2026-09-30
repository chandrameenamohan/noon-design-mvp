import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const url = "postgres://app:pw@db:5432/noon";
const rest = { SESSION_TOKEN_SECRET: "s".repeat(32), SYNC_PUBLIC_URL: "ws://localhost:3001", REDIS_URL: "redis://redis:6379" };

test("refuses to start without a real DATABASE_URL instead of falling back to a default", () => {
  for (const bad of [undefined, "", " ", "not-a-url", "http://db/noon", "postgres://"]) {
    expect(() => loadConfig({ ...rest, DATABASE_URL: bad }), JSON.stringify(bad)).toThrow(/DATABASE_URL/);
  }
  expect(loadConfig({ ...rest, DATABASE_URL: url }).databaseUrl).toBe(url);
  expect(loadConfig({ ...rest, DATABASE_URL: "postgresql://app:pw@db/noon" }).databaseUrl).toMatch(/^postgresql:/);
});

test("reads the port: decimal digits only, empty means unset, default 3000", () => {
  expect(loadConfig({ ...rest, DATABASE_URL: url }).port).toBe(3000);
  expect(loadConfig({ ...rest, DATABASE_URL: url }).nodeEnv).toBe("production"); // unset means the safe side
  expect(() => loadConfig({ ...rest, DATABASE_URL: url, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  expect(loadConfig({ ...rest, DATABASE_URL: url, PORT: "" }).port).toBe(3000);
  expect(loadConfig({ ...rest, DATABASE_URL: url, PORT: "8080" }).port).toBe(8080);
  for (const bad of ["eighty", "0x50", "1e3", " 80 ", "0", "70000", "-1"]) {
    expect(() => loadConfig({ ...rest, DATABASE_URL: url, PORT: bad }), bad).toThrow(/PORT/);
  }
});

test("the session secret and the public sync address are required, with no defaults", () => {
  expect(() => loadConfig({ ...rest, DATABASE_URL: url, SESSION_TOKEN_SECRET: undefined })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(() => loadConfig({ ...rest, DATABASE_URL: url, SESSION_TOKEN_SECRET: "too-short" })).toThrow(/SESSION_TOKEN_SECRET/);
  for (const bad of [undefined, "", "http://localhost:3001", "localhost:3001", "wss://sync.example.com/?x=1", "wss://sync.example.com#frag"]) {
    expect(() => loadConfig({ ...rest, DATABASE_URL: url, SYNC_PUBLIC_URL: bad }), String(bad)).toThrow(/SYNC_PUBLIC_URL/);
  }
  expect(loadConfig({ ...rest, DATABASE_URL: url, SYNC_PUBLIC_URL: "wss://sync.example.com/" }).sessions).toEqual({
    secret: rest.SESSION_TOKEN_SECRET,
    syncUrl: "wss://sync.example.com", // no trailing slash, so joining a path never doubles it
    ttlSeconds: 60,
  });
});

test("refuses to start without a REDIS_URL: a run that can never be queued must not be accepted quietly", () => {
  for (const bad of [undefined, "", "redis:6379", "http://redis:6379"]) expect(() => loadConfig({ ...rest, DATABASE_URL: url, REDIS_URL: bad }), JSON.stringify(bad)).toThrow(/REDIS_URL/);
  expect(loadConfig({ ...rest, DATABASE_URL: url }).redisUrl).toBe("redis://redis:6379");
});

test("the public preview origin is optional (empty = unset) and must be an http(s) origin, nothing more", () => {
  expect(loadConfig({ ...rest, DATABASE_URL: url }).previewOrigin).toBeUndefined();
  expect(loadConfig({ ...rest, DATABASE_URL: url, PREVIEW_PUBLIC_URL: "" }).previewOrigin).toBeUndefined();
  expect(loadConfig({ ...rest, DATABASE_URL: url, PREVIEW_PUBLIC_URL: "https://noon.example.com/" }).previewOrigin).toBe("https://noon.example.com");
  expect(loadConfig({ ...rest, DATABASE_URL: url, PREVIEW_PUBLIC_URL: "http://localhost:5174" }).previewOrigin).toBe("http://localhost:5174");
  for (const bad of ["noon.example.com", "wss://noon.example.com", "javascript:alert(1)", "https://noon.example.com/app", "https://noon.example.com/?x=1", "https://noon.example.com/#x", "https://me:pw@noon.example.com"]) {
    expect(() => loadConfig({ ...rest, DATABASE_URL: url, PREVIEW_PUBLIC_URL: bad }), bad).toThrow(/PREVIEW_PUBLIC_URL/);
  }
});
