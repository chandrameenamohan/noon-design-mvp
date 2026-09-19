import { expect, test } from "vitest";
import { signSessionToken, verifySessionToken } from "./index.ts";

const secret = "s".repeat(32);
const claims = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  documentId: "33333333-3333-4333-8333-333333333333",
};
const T0 = 1_800_000_000; // seconds; a fixed clock makes expiry testable without sleeping
const mint = (over: Partial<Parameters<typeof signSessionToken>[0]> = {}) =>
  signSessionToken({ ...claims, secret, ttlSeconds: 60, now: T0, ...over });
const check = (token: string, over: Partial<Parameters<typeof verifySessionToken>[0]> = {}) =>
  verifySessionToken({ token, secret, documentId: claims.documentId, now: T0 + 1, ...over });

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

test("a token names its user, org and document, and says when it expires", () => {
  const result = check(mint());
  expect(result).toEqual({ ok: true, claims: { ...claims, expiresAt: T0 + 60 } });
});

test("an expired token is rejected, exactly at its expiry second", () => {
  expect(check(mint(), { now: T0 + 59 })).toMatchObject({ ok: true });
  expect(check(mint(), { now: T0 + 60 })).toEqual({ ok: false, reason: "expired" });
});

test("a token for one document does not open another", () => {
  expect(check(mint(), { documentId: "44444444-4444-4444-8444-444444444444" })).toEqual({ ok: false, reason: "wrong_document" });
});

test("a token signed with another secret is rejected", () => {
  expect(check(mint({ secret: "x".repeat(32) }))).toEqual({ ok: false, reason: "bad_signature" });
});

test("changing any part of the token breaks the signature", () => {
  const [header, payload, signature] = mint().split(".") as [string, string, string];
  const forgedPayload = b64({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "99999999-9999-4999-8999-999999999999" });
  expect(check(`${header}.${forgedPayload}.${signature}`)).toEqual({ ok: false, reason: "bad_signature" });
  expect(check(`${header}.${payload}.${signature.slice(0, -2)}AA`)).toEqual({ ok: false, reason: "bad_signature" });
});

test("the classic JWT attack, alg=none with no signature, is rejected: the algorithm is pinned, not read from the token", () => {
  const [, payload] = mint().split(".") as [string, string, string];
  expect(check(`${b64({ alg: "none", typ: "JWT" })}.${payload}.`)).toMatchObject({ ok: false });
  expect(check(`${b64({ alg: "HS512", typ: "JWT" })}.${payload}.AAAA`)).toMatchObject({ ok: false });
});

test.each(["", "a.b", "a.b.c.d", "not a token", "....", "e30.e30.e30"])("garbage (%j) is 'malformed', never a thrown error", (token) => {
  expect(check(token)).toMatchObject({ ok: false });
});

test("a secret shorter than 32 characters is refused when signing and when verifying", () => {
  expect(() => mint({ secret: "short" })).toThrow(/secret/);
  expect(() => check(mint(), { secret: "short" })).toThrow(/secret/);
});
