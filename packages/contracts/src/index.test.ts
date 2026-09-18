import { expect, test } from "vitest";
import { HealthResponse } from "./index.ts";

const valid = { status: "ok", service: "api" };

test("accepts a valid health body", () => {
  expect(HealthResponse.parse(valid)).toEqual(valid);
});

// One invalid field per case: a test that breaks two rules at once keeps
// passing when either rule is deleted.
test.each([
  ["status is not the literal ok", { ...valid, status: "down" }],
  ["service is empty", { ...valid, service: "" }],
  ["service is missing", { status: "ok" }],
])("rejects when %s", (_name, fromTheWire: unknown) => {
  expect(HealthResponse.safeParse(fromTheWire).success).toBe(false);
});
