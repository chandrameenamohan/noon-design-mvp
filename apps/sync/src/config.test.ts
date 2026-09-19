import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const secret = "s".repeat(32);
const DATABASE_URL = "postgres://app:pw@db:5432/noon";

test("the session secret is required, may be a rotation list, and every entry must be long enough", () => {
  expect(() => loadConfig({ DATABASE_URL })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(() => loadConfig({ SESSION_TOKEN_SECRET: secret })).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ SESSION_TOKEN_SECRET: secret, DATABASE_URL: "not-a-url" })).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: "short" })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(() => loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: `${secret},short` })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: secret })).toEqual({ databaseUrl: DATABASE_URL, secrets: [secret], port: 3001 });
  expect(loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: `${"n".repeat(32)}, ${secret}`, PORT: "4000" })).toMatchObject({ secrets: ["n".repeat(32), secret], port: 4000 });
});
