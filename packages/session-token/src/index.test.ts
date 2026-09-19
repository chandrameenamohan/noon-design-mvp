import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { signSessionToken, verifySessionToken } from "./index.ts";

const secret = "s".repeat(32);
const claims = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  documentId: "33333333-3333-4333-8333-333333333333",
};
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const T0 = 1_800_000_000; // seconds; a fixed clock makes expiry testable without sleeping
/** Signs an arbitrary payload with the real secret: what only WE could produce, but malformed. */
function signRaw(payload: unknown): string {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

const mint = (over: Partial<Parameters<typeof signSessionToken>[0]> = {}) =>
  signSessionToken({ ...claims, secret, ttlSeconds: 60, now: T0, ...over });
const check = (token: string, over: Partial<Parameters<typeof verifySessionToken>[0]> = {}) =>
  verifySessionToken({ token, secrets: [secret], documentId: claims.documentId, now: T0 + 1, ...over });


test("a token names its user, org and document, and says when it expires", () => {
  const result = check(mint());
  expect(result).toEqual({ ok: true, claims: { ...claims, expiresAt: T0 + 60, actor: { kind: "user" } } });
  expect(check(mint({ actor: { kind: "agent", runId: "run-7" } }))).toMatchObject({ ok: true, claims: { actor: { kind: "agent", runId: "run-7" } } });
});

test("an expired token is rejected, exactly at its expiry second", () => {
  expect(check(mint(), { now: T0 + 59 })).toMatchObject({ ok: true });
  expect(check(mint(), { now: T0 + 60 })).toEqual({ ok: false, reason: "expired" });
});

test("a verifier may allow a few seconds of clock skew, and no more", () => {
  expect(check(mint(), { now: T0 + 64, leewaySeconds: 5 })).toMatchObject({ ok: true });
  expect(check(mint(), { now: T0 + 65, leewaySeconds: 5 })).toEqual({ ok: false, reason: "expired" });
});

test("a token for one document does not open another", () => {
  expect(check(mint(), { documentId: "44444444-4444-4444-8444-444444444444" })).toEqual({ ok: false, reason: "wrong_document" });
});

test("a token signed with another secret is rejected", () => {
  expect(check(mint({ secret: "x".repeat(32) }))).toEqual({ ok: false, reason: "bad_signature" });
});

test("during a secret rotation a verifier accepts tokens signed with EITHER secret", () => {
  const oldSecret = "o".repeat(32);
  expect(check(mint({ secret: oldSecret }), { secrets: [secret, oldSecret] })).toMatchObject({ ok: true });
  expect(check(mint(), { secrets: [secret, oldSecret] })).toMatchObject({ ok: true });
  expect(() => check(mint(), { secrets: [] })).toThrow(/secret/);
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
  expect(() => check(mint(), { secrets: ["short"] })).toThrow(/secret/);
});

test("exactly ONE string verifies per token: a re-encoded signature is refused", () => {
  // Node's base64url decoder is lax: padding, standard-base64 characters, stray characters and the
  // unused bits of the last character all decode to the same bytes. If several strings verified,
  // anything keyed on the token string later (a replay cache, a revocation list) could be bypassed.
  const token = mint();
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const sameBytes = (s: string): boolean => Buffer.from(s, "base64url").equals(Buffer.from(signature, "base64url"));
  const last = signature.slice(-1);
  const twin = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_").find((ch) => ch !== last && sameBytes(signature.slice(0, -1) + ch));
  const variants = [`${signature}=`, `${signature}*`, `*${signature}`, signature.replace(/-/g, "+").replace(/_/g, "/"), ...(twin ? [signature.slice(0, -1) + twin] : [])].filter((v) => v !== signature);
  expect(variants.length).toBeGreaterThan(2);
  for (const variant of variants) {
    expect(sameBytes(variant), variant).toBe(true); // same bytes...
    expect(check(`${header}.${payload}.${variant}`), variant).toEqual({ ok: false, reason: "bad_signature" }); // ...still refused
  }
  expect(check(token)).toMatchObject({ ok: true });
});

test("a correctly signed payload that is not a session token is 'malformed'", () => {
  const { documentId, userId, orgId } = claims;
  const good = { sub: userId, org: orgId, doc: documentId, aud: "sync", iat: T0, exp: T0 + 60 };
  expect(check(signRaw(good))).toMatchObject({ ok: true });
  expect(check(signRaw({ ...good, doc: undefined }))).toEqual({ ok: false, reason: "malformed" });
  expect(check(signRaw({ ...good, sub: "not-a-uuid" }))).toEqual({ ok: false, reason: "malformed" });
  expect(check(signRaw("just a string"))).toEqual({ ok: false, reason: "malformed" });
});

test("a token minted for another purpose is refused, even when signed with the same secret", () => {
  const { documentId, userId, orgId } = claims;
  const base = { sub: userId, org: orgId, doc: documentId, iat: T0, exp: T0 + 60 };
  expect(check(signRaw({ ...base, aud: "login" }))).toEqual({ ok: false, reason: "malformed" });
  expect(check(signRaw(base))).toEqual({ ok: false, reason: "malformed" }); // no audience at all
});

test("a token that would already be expired cannot be minted", () => {
  expect(() => mint({ ttlSeconds: 0 })).toThrow(/ttl/);
  expect(() => mint({ ttlSeconds: -5 })).toThrow(/ttl/);
});

test("a token can carry the display name the api knows; without one the claims simply have none", () => {
  const named = check(mint({ name: "Ada Lovelace" }));
  expect(named.ok && named.claims.name).toBe("Ada Lovelace");
  const plain = check(mint());
  expect(plain.ok && "name" in plain.claims).toBe(false);
  expect(() => mint({ name: "x".repeat(201) })).toThrow();
});
