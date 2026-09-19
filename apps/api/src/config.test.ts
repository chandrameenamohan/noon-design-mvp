import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

test("refuses to start without DATABASE_URL instead of falling back to a default", () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
});

test("reads the port, defaulting to 3000, and rejects nonsense", () => {
  const url = "postgres://app:pw@db/noon";
  expect(loadConfig({ DATABASE_URL: url })).toEqual({ databaseUrl: url, port: 3000 });
  expect(loadConfig({ DATABASE_URL: url, PORT: "8080" }).port).toBe(8080);
  expect(() => loadConfig({ DATABASE_URL: url, PORT: "eighty" })).toThrow(/PORT/);
});
