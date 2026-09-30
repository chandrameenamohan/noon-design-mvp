import { expect, test } from "vitest";
import { dummyHash, hashPassword, hashToken, isSessionToken, newSessionToken, verifyPassword } from "./password.ts";

test("a password verifies against its own hash and nothing else; two hashes of one password differ (salted)", async () => {
  const stored = await hashPassword("correct horse battery");
  expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
  expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  expect(await verifyPassword("", stored)).toBe(false);
  expect(await hashPassword("correct horse battery")).not.toBe(stored);
});

test("the same password typed as another Unicode form still verifies (NFKC)", async () => {
  const composed = "caf" + String.fromCharCode(0xe9) + " au lait";
  const decomposed = "cafe" + String.fromCharCode(0x301) + " au lait";
  expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
});

test("a stored value that is not ours, is cut short, or asks for absurd work is a plain no, never a throw or a hang", async () => {
  const stored = await hashPassword("pw-pw-pw-pw");
  const [, , , , salt, key] = stored.split("$");
  for (const bad of ["", "plaintext", stored.slice(0, -4), `scrypt$1099511627776$8$1$${salt ?? ""}$${key ?? ""}`, `scrypt$3$8$1$${salt ?? ""}$${key ?? ""}`, `scrypt$32768$8$1$${salt ?? ""}$${Buffer.alloc(16).toString("base64url")}`, `bcrypt$32768$8$1$${salt ?? ""}$${key ?? ""}`]) {
    expect(await verifyPassword("pw-pw-pw-pw", bad), bad).toBe(false);
  }
});

test("the dummy hash is a real scrypt hash, computed once, that no ordinary password matches", async () => {
  const first = await dummyHash();
  expect(first).toMatch(/^scrypt\$/);
  expect(await dummyHash()).toBe(first);
  expect(await verifyPassword("", first)).toBe(false);
});

test("session tokens are 32 random bytes; only their hash is kept; the lookup accepts only that shape", () => {
  const a = newSessionToken();
  const b = newSessionToken();
  expect(a.token).not.toBe(b.token);
  expect(Buffer.from(a.token, "base64url")).toHaveLength(32);
  expect(a.hash).toEqual(hashToken(a.token));
  expect(a.hash).toHaveLength(32);
  expect(a.hash.toString("base64url")).not.toBe(a.token);
  expect(isSessionToken(a.token)).toBe(true);
  for (const bad of [undefined, "", a.token.slice(1), `${a.token}=`, `${a.token.slice(1)}+`, "x".repeat(4096)]) expect(isSessionToken(bad), String(bad)).toBe(false);
});
