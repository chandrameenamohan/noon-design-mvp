import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { readPush, signatureMatches } from "./webhook.ts";

const secret = "a-webhook-secret-of-at-least-32-chars";
const sign = (body: Buffer | string, key = secret): string => createHmac("sha256", key).update(body).digest("hex");
const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);
const push = (fields: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({ ref: "refs/heads/main", before: A, after: B, commits: [], repository: { full_name: "noon/sample-app" }, ...fields }));

test("a signature is the hex HMAC-SHA256 of the exact bytes, under the configured secret", () => {
  const body = push();
  expect(signatureMatches(body, sign(body), secret)).toBe(true);
  expect(signatureMatches(body, sign(body, "another-secret-another-secret-00"), secret)).toBe(false);
  // One byte of whitespace is another body: the RAW bytes are signed, never a re-serialised parse.
  expect(signatureMatches(Buffer.concat([body, Buffer.from(" ")]), sign(body), secret)).toBe(false);
});

test("anything that is not exactly 64 lowercase hex digits is refused, never compared", () => {
  const body = push();
  const good = sign(body);
  for (const bad of [undefined, "", good.slice(0, 63), `${good}0`, good.toUpperCase(), `sha256=${good}`, ` ${good}`, "z".repeat(64), `${good.slice(0, 62)}é`]) {
    expect(signatureMatches(body, bad, secret), JSON.stringify(bad)).toBe(false);
  }
});

test("a push to a branch is a commit event: ref, before, after", () => {
  expect(readPush(push())).toEqual({ kind: "event", ref: "refs/heads/main", before: A, after: B });
  expect(readPush(push({ ref: "refs/heads/noon/0f9c7a0e-1b2c-4d3e-8f00-000000000001" }))).toMatchObject({ kind: "event" });
});

test("the registration push (before is all zeros) is ignored, and so is every new branch it looks like", () => {
  expect(readPush(push({ before: ZERO }))).toEqual({ kind: "ignored", reason: "synthetic" });
});

test("a deleted branch, a tag and a ref name git would not write are ignored, not stored", () => {
  expect(readPush(push({ after: ZERO }))).toEqual({ kind: "ignored", reason: "deleted" });
  expect(readPush(push({ ref: "refs/tags/v1" }))).toEqual({ kind: "ignored", reason: "not_a_branch" });
  for (const ref of ["refs/heads/", "refs/heads/a..b", "refs/heads/-x", "refs/heads/a b", "refs/heads/a\nb", `refs/heads/${"x".repeat(250)}`, "main"]) {
    expect(readPush(push({ ref })), JSON.stringify(ref)).toEqual({ kind: "ignored", reason: "not_a_branch" });
  }
});

test("a body that is not a push is invalid, with nothing guessed", () => {
  expect(readPush(Buffer.from("not json"))).toEqual({ kind: "invalid", error: "invalid_json" });
  expect(readPush(Buffer.from("[]"))).toEqual({ kind: "invalid", error: "invalid_body" });
  expect(readPush(push({ after: "B".repeat(40) }))).toEqual({ kind: "invalid", error: "invalid_body" });
  expect(readPush(push({ before: 7 }))).toEqual({ kind: "invalid", error: "invalid_body" });
  expect(readPush(push({ ref: undefined }))).toEqual({ kind: "invalid", error: "invalid_body" });
});
