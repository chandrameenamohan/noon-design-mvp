// Assumption 11: `node --test` should discover and run *.test.ts natively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { double } from "@nt/lib/utils";

test("double doubles a number", () => {
  const result: number = double(21);
  assert.equal(result, 42);
});
