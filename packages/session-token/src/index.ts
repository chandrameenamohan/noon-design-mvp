import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// A session token lets a peer open ONE document's WebSocket for a short time. The api signs it,
// the sync server verifies it: they share a secret and never have to call each other.
//
// The format is a standard HS256 JWT (header.payload.signature, base64url), so any JWT tool can
// read one. Two things are deliberately NOT standard-library-of-the-internet behaviour:
//   - the algorithm is PINNED. The token's own "alg" header is never used to choose how to verify,
//     which is what makes the "alg: none" and algorithm-swap attacks impossible here;
//   - verification returns a reason instead of throwing, because a bad token is an expected input;
//   - exactly ONE string verifies per token (see the canonical-encoding check below).
// The header is compared byte for byte, so any other signer of ours must emit exactly these bytes.
// The role is deliberately NOT a claim: a token is checked once, at connect, and the socket then
// lives for hours, so a role in it would be stale. The sync server reads the role itself (E8.2).

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const MIN_SECRET_LENGTH = 32;

// `aud` says what the token is FOR. Epic 8 will mint other tokens; none of them may open a document.
const Payload = z.object({ sub: z.uuid(), org: z.uuid(), doc: z.uuid(), aud: z.literal("sync"), iat: z.number().int(), exp: z.number().int() });

type SessionClaims = { userId: string; orgId: string; documentId: string; expiresAt: number };
type VerifyResult =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_document" };

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function sign(data: string, secret: string): Buffer {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`session token secret must be at least ${String(MIN_SECRET_LENGTH)} characters`);
  return createHmac("sha256", secret).update(data).digest();
}

export function signSessionToken({ userId, orgId, documentId, secret, ttlSeconds, now = nowSeconds() }: {
  userId: string;
  orgId: string;
  documentId: string;
  secret: string;
  ttlSeconds: number;
  now?: number;
}): string {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("session token ttl must be a whole number of seconds, at least 1");
  const payload = Payload.parse({ sub: userId, org: orgId, doc: documentId, aud: "sync", iat: now, exp: now + ttlSeconds });
  const body = `${HEADER}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${sign(body, secret).toString("base64url")}`;
}

/**
 * `documentId` is the document the caller is trying to open: a token for another document is refused.
 * `secrets` is a list so a secret can be ROTATED without an outage: give every verifier [new, old],
 * switch the signer to the new one, wait out the 60-second lifetime, then drop the old one.
 */
export function verifySessionToken({ token, secrets, documentId, now = nowSeconds() }: {
  token: string;
  secrets: readonly string[];
  documentId: string;
  now?: number;
}): VerifyResult {
  if (secrets.length === 0) throw new Error("at least one session token secret is required");
  // Computing the candidates first also validates every secret, even when the token is garbage:
  // a short secret is a configuration error and must surface, not hide behind "malformed".
  const parts = token.split(".");
  const [header, payload, signature] = parts;
  const body = `${header ?? ""}.${payload ?? ""}`;
  const candidates = secrets.map((secret) => sign(body, secret));
  if (parts.length !== 3 || header === undefined || payload === undefined || signature === undefined) {
    return { ok: false, reason: "malformed" };
  }

  // Signature first, over the exact bytes received, in constant time: nothing in the token is
  // trusted (or even parsed) until this passes. The header must be OUR header, byte for byte.
  const given = Buffer.from(signature, "base64url");
  // Node decodes base64url leniently (padding, "+" and "/", stray characters, the unused bits of
  // the last character), so several strings decode to one signature. Only the canonical one may
  // pass, or anything later keyed on the token string (a replay cache, a revocation list) breaks.
  const canonical = given.toString("base64url") === signature;
  const matches = candidates.some((wanted) => given.length === wanted.length && timingSafeEqual(given, wanted));
  if (header !== HEADER || !canonical || !matches) return { ok: false, reason: "bad_signature" };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = Payload.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (now >= parsed.data.exp) return { ok: false, reason: "expired" };
  if (parsed.data.doc !== documentId) return { ok: false, reason: "wrong_document" };
  return { ok: true, claims: { userId: parsed.data.sub, orgId: parsed.data.org, documentId: parsed.data.doc, expiresAt: parsed.data.exp } };
}
