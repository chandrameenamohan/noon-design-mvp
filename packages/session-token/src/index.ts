import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// A session token lets a peer open ONE document's WebSocket for a short time. The api signs it,
// the sync server verifies it: they share a secret and never have to call each other.
//
// The format is a standard HS256 JWT (header.payload.signature, base64url), so any JWT tool can
// read one. Two things are deliberately NOT standard-library-of-the-internet behaviour:
//   - the algorithm is PINNED. The token's own "alg" header is never used to choose how to verify,
//     which is what makes the "alg: none" and algorithm-swap attacks impossible here;
//   - verification returns a reason instead of throwing, because a bad token is an expected input.

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const MIN_SECRET_LENGTH = 32;

const Payload = z.object({ sub: z.uuid(), org: z.uuid(), doc: z.uuid(), iat: z.number().int(), exp: z.number().int() });

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
  const payload = Payload.parse({ sub: userId, org: orgId, doc: documentId, iat: now, exp: now + ttlSeconds });
  const body = `${HEADER}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${sign(body, secret).toString("base64url")}`;
}

/** `documentId` is the document the caller is trying to open: a token for another document is refused. */
export function verifySessionToken({ token, secret, documentId, now = nowSeconds() }: {
  token: string;
  secret: string;
  documentId: string;
  now?: number;
}): VerifyResult {
  const expected = (body: string): Buffer => sign(body, secret); // also validates the secret, before anything else
  const parts = token.split(".");
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || header === undefined || payload === undefined || signature === undefined) {
    expected(""); // a short secret is a configuration error and must surface even for a garbage token
    return { ok: false, reason: "malformed" };
  }

  // Signature first, over the exact bytes received, in constant time: nothing in the token is
  // trusted (or even parsed) until this passes. The header must be OUR header, byte for byte.
  const given = Buffer.from(signature, "base64url");
  const wanted = expected(`${header}.${payload}`);
  if (header !== HEADER || given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, reason: "bad_signature" };
  }

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
