import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * E8.1 (F23): passwords and sign-in tokens, with Node's own crypto and nothing else.
 *
 * scrypt, because it is slow AND memory-hard (a GPU farm pays in RAM as well as time), and it ships with Node.
 * N=2^15, r=8: 32 MiB and some tens of milliseconds per guess. The stored string names its parameters, so they
 * can be raised later and every older hash still verifies.
 */
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_BYTES = 32;
const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...cost, maxmem: 256 * cost.N * cost.r };
  return new Promise((resolve, reject) => {
    // NFKC: the same password typed on two keyboards can arrive as two byte sequences (NIST 800-63B asks for this).
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return `scrypt$${String(COST.N)}$${String(COST.r)}$${String(COST.p)}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant time over the derived key. A stored string that is not ours (or asks for absurd work) is simply "no". */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (!match) return false;
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // A row edited to ask for 2^40 would be a denial of service on every sign-in; ours never exceed these.
  if (N > 2 ** 20 || r > 16 || p > 4) return false;
  const expected = Buffer.from(match[5] ?? "", "base64url");
  if (expected.length !== KEY_BYTES) return false;
  // Parameters scrypt refuses (N not a power of two, say) reject: that is a no as well.
  const key = await derive(password, Buffer.from(match[4] ?? "", "base64url"), { N, r, p }).catch(() => undefined);
  return key !== undefined && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/**
 * A real hash of a password nobody knows. Sign-in verifies against it when the email has no account, so "no such
 * user" costs exactly one scrypt, as "wrong password" does: the response time does not tell which it was.
 */
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword(randomBytes(32).toString("hex")));

/** 32 random bytes: unguessable. The browser keeps the token; the database keeps only its SHA-256. */
export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
export const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();
/** The exact shape `newSessionToken` makes. Anything else is never looked up. */
export const isSessionToken = (value: string | undefined): value is string => value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
