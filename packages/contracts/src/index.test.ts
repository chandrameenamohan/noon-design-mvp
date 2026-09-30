import { expect, test } from "vitest";
import { AuditEntry, HealthResponse, IdempotencyKey, includes, MemberPage, Preview, Role, SandboxUrl, SessionResponse, ShareBody, SignUpBody, UsageAmount } from "./index.ts";

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

// F24: the roles are nested. Every pair, so that a rank swapped or a comparison flipped is caught.
test("an owner may do what an editor may, an editor what a viewer may, and never the other way", () => {
  const allowed = Role.options.flatMap((role) => Role.options.filter((need) => includes(role, need)).map((need) => `${role}>=${need}`));
  expect(allowed.sort()).toEqual(["editor>=editor", "editor>=viewer", "owner>=editor", "owner>=owner", "owner>=viewer", "viewer>=viewer"]);
});

// F25: a share is a way into one document, never into the org: it can never make someone an owner.
test("a document is shared at editor or viewer, and never at owner", () => {
  const share = (role: string) => ShareBody.safeParse({ email: "outside@example.com", role }).success;
  expect(["editor", "viewer", "owner", ""].map(share)).toEqual([true, true, false, false]);
  expect(ShareBody.safeParse({ email: "outside@example.com", role: "viewer", orgId: "x" }).success).toBe(false);
});

// E10.8: a member list is one page of members and nothing else; the session answer may name the caller's role, and only a role.
test("a member page is items and a cursor, each item a member; a session's role is one of the three or absent", () => {
  const member = { userId: "0f9c7a0e-1b2c-4d3e-8f00-000000000003", email: "o@example.com", name: "Olu", role: "viewer" };
  expect(MemberPage.parse({ items: [member], nextCursor: null })).toEqual({ items: [member], nextCursor: null });
  expect(MemberPage.safeParse({ items: [{ ...member, role: "admin" }], nextCursor: null }).success).toBe(false);
  expect(MemberPage.safeParse({ items: [member], nextCursor: null, total: 1 }).success).toBe(false);
  const session = { wsUrl: "ws://sync.test/documents/d", token: "t", expiresAt: "2026-09-30T00:00:00.000Z" };
  expect(SessionResponse.parse({ ...session, role: "owner" })).toHaveProperty("role", "owner");
  expect(SessionResponse.parse(session)).not.toHaveProperty("role");
  expect(SessionResponse.safeParse({ ...session, role: "admin" }).success).toBe(false);
});

test("an audit entry's detail is flat text, and its action and actor kind are ones the view has words for", () => {
  const entry = {
    id: "0f9c7a0e-1b2c-4d3e-8f00-000000000001", orgId: "0f9c7a0e-1b2c-4d3e-8f00-000000000002",
    actor: { kind: "user", id: "0f9c7a0e-1b2c-4d3e-8f00-000000000003", email: "o@example.com" },
    action: "run_started", documentId: null, detail: { instruction: "<b>markup stays text</b>" }, at: "2026-09-30T00:00:00.000Z",
  };
  expect(AuditEntry.parse(entry)).toEqual(entry);
  expect(AuditEntry.safeParse({ ...entry, detail: { nested: { x: "y" } } }).success).toBe(false);
  expect(AuditEntry.safeParse({ ...entry, detail: { count: 3 } }).success).toBe(false);
  expect(AuditEntry.safeParse({ ...entry, action: "made_up" }).success).toBe(false);
  expect(AuditEntry.safeParse({ ...entry, actor: { ...entry.actor, kind: "robot" } }).success).toBe(false);
  expect(AuditEntry.safeParse({ ...entry, extra: 1 }).success).toBe(false);
});

// E9.1: the key is stored in a text column whose check is the same rule, and goes into a unique key: no looser than it.
test("an idempotency key is 1 to 255 printable ASCII characters, as the column that stores it demands", () => {
  expect(IdempotencyKey.safeParse(crypto.randomUUID()).success).toBe(true);
  expect(IdempotencyKey.safeParse("!".repeat(255)).success).toBe(true);
  expect(IdempotencyKey.safeParse("").success).toBe(false);
  expect(IdempotencyKey.safeParse("k".repeat(256)).success).toBe(false);
  expect(IdempotencyKey.safeParse("a key").success).toBe(false); // a space is not printable here
  expect(IdempotencyKey.safeParse("clé").success).toBe(false);
  expect(IdempotencyKey.safeParse("a\nb").success).toBe(false);
});
