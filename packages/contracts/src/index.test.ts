import { expect, test } from "vitest";
import { HealthResponse, Preview, SandboxUrl, SignUpBody, UsageAmount } from "./index.ts";

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

// From the E3.4 review panel: a contract must be at least as strict as the strictest system behind it.
// Behind UsageAmount are a numeric(12,6) column, a bigint column, and a READER that turns both into a
// JS number. Anything this schema lets through that they cannot hold is a usage row silently lost.
test("UsageAmount is no looser than the column it is stored in, or the number it is read back as", () => {
  const fine = { model: "claude-opus-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0123 };
  expect(UsageAmount.safeParse(fine).success).toBe(true);
  expect(UsageAmount.safeParse({ ...fine, costUsd: 999_999.999_999 }).success).toBe(true); // the largest numeric(12,6)
  expect(UsageAmount.safeParse({ ...fine, costUsd: 1_000_000 }).success).toBe(false); // Postgres would refuse it, after the run had already worked
  expect(UsageAmount.safeParse({ ...fine, costUsd: 1e12 }).success).toBe(false);
  expect(UsageAmount.safeParse({ ...fine, inputTokens: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  expect(UsageAmount.safeParse({ ...fine, inputTokens: Number.MAX_SAFE_INTEGER + 2 }).success).toBe(false); // it would not read back as itself
  expect(UsageAmount.safeParse({ ...fine, model: "x".repeat(100) }).success).toBe(true);
  expect(UsageAmount.safeParse({ ...fine, model: "x".repeat(101) }).success).toBe(false);
});

// noon-l96: behind one public URL the canvas frames the preview on its own origin, under /preview/.
const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";
const token = "0123456789abcdef.0123456789abcdef0123456789abcdef";
test("a preview answers on the loopback, or under /preview/<document>/<token>/ (the canvas checks the origin)", () => {
  for (const url of [`http://127.0.0.1:20000/preview/${doc}/${token}/noon-preview/?doc=${doc}`, `https://noon.example.com/preview/${doc}/${token}/noon-preview/?doc=${doc}&started=1`]) {
    expect(Preview.parse({ status: "running", url }).url).toBe(url);
  }
  for (const url of ["https://noon.example.com/noon-preview/", `https://noon.example.com/elsewhere/preview/${doc}/${token}/`, `javascript:alert(1)//preview/${doc}/${token}/`, `https://noon.example.com/preview/${doc}/20001/`]) {
    expect(Preview.safeParse({ status: "running", url }).success, url).toBe(false);
  }
});
test("what the worker stores is the loopback, nowhere else, whatever the path", () => {
  expect(SandboxUrl.safeParse(`http://127.0.0.1:20000/preview/${doc}/${token}/`).success).toBe(true);
  expect(SandboxUrl.safeParse(`https://noon.example.com/preview/${doc}/${token}/`).success).toBe(false);
});

// F23, and the E2.6 finding: presence shows every name to everyone live, so the name a person signs up with
// must read as what it is. Built with fromCharCode: the characters themselves are invisible in this file.
test("a sign-up name refuses invisible formatting and stacked combining marks; ordinary names pass", () => {
  const body = (name: string) => SignUpBody.safeParse({ email: "ann@example.com", name, password: "correct horse" }).success;
  expect(body("Ann Lee")).toBe(true);
  expect(body("Zoë Ñúñez")).toBe(true); // one combining mark, or a precomposed letter, is a name
  expect(body("Nguyễn")).toBe(true);
  expect(body(`adm${String.fromCharCode(0x202e)}nimda`)).toBe(false); // right-to-left override
  expect(body(`An${String.fromCharCode(0x200b)}n`)).toBe(false); // zero-width space
  expect(body(`Ann${String.fromCharCode(0x0301, 0x0301, 0x0301)}`)).toBe(false);
});

test("a sign-up password is 8 to 128 characters and nothing else is demanded of it", () => {
  const body = (password: string) => SignUpBody.safeParse({ email: "ann@example.com", name: "Ann", password }).success;
  expect(body("x".repeat(7))).toBe(false);
  expect(body("x".repeat(8))).toBe(true);
  expect(body("x".repeat(128))).toBe(true);
  expect(body("x".repeat(129))).toBe(false);
  expect(SignUpBody.safeParse({ email: "ann@example.com", name: "Ann", password: "x".repeat(8), role: "owner" }).success).toBe(false);
});
