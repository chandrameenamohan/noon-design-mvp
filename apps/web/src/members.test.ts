import { expect, test } from "vitest";
import { Role, type Member } from "@noon/contracts";
import { memberRefusalWords, ROLE_WORDS, ROLES_TO_OFFER, roleOf, shareRefusalWords, withMember, withoutMember, type MemberRefusal, type ShareRefusal } from "./members.ts";

const member = (userId: string, role: Member["role"]): Member => ({ userId, email: `${userId}@example.com`, name: userId, role });

// E10.8: a refusal is a sentence, never the api's name; the last owner's is the one the bead names.
test("every refusal the api can answer has a sentence, and last_owner says the org must keep an owner", () => {
  const memberRefusals: MemberRefusal[] = ["no_user", "last_owner", "forbidden", "gone"];
  for (const refusal of memberRefusals) expect(memberRefusalWords(refusal)).toMatch(/^[A-Z].*\.$/);
  expect(memberRefusalWords("last_owner")).toContain("at least one owner");
  expect(memberRefusalWords("last_owner")).not.toContain("last_owner");
  const shareRefusals: ShareRefusal[] = ["no_user", "forbidden", "gone"];
  for (const refusal of shareRefusals) expect(shareRefusalWords(refusal)).toMatch(/^[A-Z].*\.$/);
  expect(shareRefusalWords("forbidden")).toContain("owner");
});

test("every role has words, and the form offers all three, the most limited first", () => {
  expect(Object.keys(ROLE_WORDS).sort()).toEqual([...Role.options].sort());
  expect(ROLES_TO_OFFER).toEqual(["viewer", "editor", "owner"]);
});

test("the caller's role is read from the list; someone not in it (or nobody) has none", () => {
  const members = [member("a", "owner"), member("b", "viewer")];
  expect(roleOf(members, "a")).toBe("owner");
  expect(roleOf(members, "b")).toBe("viewer");
  expect(roleOf(members, "c")).toBeUndefined();
  expect(roleOf(members, undefined)).toBeUndefined();
});

test("a changed member replaces their row in place, a new one is added last, a revoked one is gone; the input is not touched", () => {
  const members = [member("a", "owner"), member("b", "viewer")];
  expect(withMember(members, member("b", "editor")).map((m) => `${m.userId}:${m.role}`)).toEqual(["a:owner", "b:editor"]);
  expect(withMember(members, member("c", "viewer")).map((m) => m.userId)).toEqual(["a", "b", "c"]);
  expect(withoutMember(members, "a").map((m) => m.userId)).toEqual(["b"]);
  expect(withoutMember(members, "zzz")).toHaveLength(2);
  expect(members.map((m) => m.role)).toEqual(["owner", "viewer"]);
});
