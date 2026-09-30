import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// E5.3a: Gitea's push webhook. The pure half (the route is in app.ts): who sent it, and what it says.
// The endpoint is public, so everything here assumes a stranger wrote the request until the HMAC says otherwise.

const HEX_SIGNATURE = /^[0-9a-f]{64}$/;

/**
 * True when `header` is the hex HMAC-SHA256 of these exact bytes under `secret` (X-Gitea-Signature,
 * learning-tests/gitea FINDINGS 3). The RAW body is signed: a parse-and-reserialise would verify
 * something Gitea never sent. Compared in constant time; a malformed header is refused before any compare.
 */
export function signatureMatches(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || !HEX_SIGNATURE.test(header)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(header, "hex")); // both 32 bytes: the regex fixed the length
}

const Sha = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/); // sha1 or sha256 object ids, lowercase as git prints them
const ZERO = /^0+$/;
/**
 * A branch as git would name it, narrowed to what a person pushes: it becomes a row, a log line and, in
 * E5.3b, a git argument. Anything else (tags, notes, odd names) is ignored, not stored.
 */
const BRANCH = /^refs\/heads\/(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;
const Push = z.object({ ref: z.string(), before: Sha, after: Sha });

export type PushReading =
  | { kind: "event"; ref: string; before: string; after: string }
  | { kind: "ignored"; reason: "synthetic" | "deleted" | "not_a_branch" }
  | { kind: "invalid"; error: "invalid_json" | "invalid_body" };

/** What a VERIFIED push body says. Only ref/before/after are read: the commit list is truncated for big pushes, so the git peer reads the mirror. */
export function readPush(raw: Buffer): PushReading {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return { kind: "invalid", error: "invalid_json" };
  }
  const parsed = Push.safeParse(json);
  if (!parsed.success) return { kind: "invalid", error: "invalid_body" };
  const { ref, before, after } = parsed.data;
  if (!BRANCH.test(ref)) return { kind: "ignored", reason: "not_a_branch" };
  if (ZERO.test(after)) return { kind: "ignored", reason: "deleted" };
  // Registering the hook fires a push whose `before` is all zeros (FINDINGS 2). A real new branch looks the
  // same and is ignored too: the git peer's reconcile finds it in the mirror (SPEC §2a).
  if (ZERO.test(before)) return { kind: "ignored", reason: "synthetic" };
  return { kind: "event", ref, before, after };
}
