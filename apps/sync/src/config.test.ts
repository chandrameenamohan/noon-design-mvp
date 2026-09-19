import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const secret = "s".repeat(32);

test("the session secret is required, may be a rotation list, and every entry must be long enough", () => {
  expect(() => loadConfig({})).toThrow(/SESSION_TOKEN_SECRET/);
  expect(() => loadConfig({ SESSION_TOKEN_SECRET: "short" })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(() => loadConfig({ SESSION_TOKEN_SECRET: `${secret},short` })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(loadConfig({ SESSION_TOKEN_SECRET: secret })).toEqual({ secrets: [secret], port: 3001 });
  expect(loadConfig({ SESSION_TOKEN_SECRET: `${"n".repeat(32)}, ${secret}`, PORT: "4000" })).toEqual({ secrets: ["n".repeat(32), secret], port: 4000 });
});
