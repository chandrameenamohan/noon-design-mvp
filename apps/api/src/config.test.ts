import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const url = "postgres://app:pw@db:5432/noon";
const rest = { SESSION_TOKEN_SECRET: "s".repeat(32), SYNC_PUBLIC_URL: "ws://localhost:3001" };

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
  for (const bad of [undefined, "", "http://localhost:3001", "localhost:3001"]) {
    expect(() => loadConfig({ ...rest, DATABASE_URL: url, SYNC_PUBLIC_URL: bad }), String(bad)).toThrow(/SYNC_PUBLIC_URL/);
  }
  expect(loadConfig({ ...rest, DATABASE_URL: url, SYNC_PUBLIC_URL: "wss://sync.example.com/" }).sessions).toEqual({
    secret: rest.SESSION_TOKEN_SECRET,
    syncUrl: "wss://sync.example.com", // no trailing slash, so joining a path never doubles it
    ttlSeconds: 60,
  });
});
