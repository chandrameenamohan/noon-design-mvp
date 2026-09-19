import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const url = "postgres://app:pw@db:5432/noon";

test("refuses to start without a real DATABASE_URL instead of falling back to a default", () => {
  for (const bad of [undefined, "", " ", "not-a-url", "http://db/noon", "postgres://"]) {
    expect(() => loadConfig({ DATABASE_URL: bad }), JSON.stringify(bad)).toThrow(/DATABASE_URL/);
  }
  expect(loadConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
  expect(loadConfig({ DATABASE_URL: "postgresql://app:pw@db/noon" }).databaseUrl).toMatch(/^postgresql:/);
});

test("reads the port: decimal digits only, empty means unset, default 3000", () => {
  expect(loadConfig({ DATABASE_URL: url }).port).toBe(3000);
  expect(loadConfig({ DATABASE_URL: url }).nodeEnv).toBe("production"); // unset means the safe side
  expect(() => loadConfig({ DATABASE_URL: url, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  expect(loadConfig({ DATABASE_URL: url, PORT: "" }).port).toBe(3000);
  expect(loadConfig({ DATABASE_URL: url, PORT: "8080" }).port).toBe(8080);
  for (const bad of ["eighty", "0x50", "1e3", " 80 ", "0", "70000", "-1"]) {
    expect(() => loadConfig({ DATABASE_URL: url, PORT: bad }), bad).toThrow(/PORT/);
  }
});
