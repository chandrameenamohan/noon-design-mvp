import { expect, test } from "vitest";
import { HealthResponse } from "./index.ts";

test("accepts a valid health body", () => {
  expect(HealthResponse.parse({ status: "ok", service: "api" })).toEqual({ status: "ok", service: "api" });
});

test("rejects a body the type system cannot see at runtime", () => {
  const fromTheWire: unknown = { status: "down", service: "" };
  const result = HealthResponse.safeParse(fromTheWire);
  expect(result.success).toBe(false);
});
