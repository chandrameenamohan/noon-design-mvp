import type { Member, Role } from "@noon/contracts";

/**
 * Words for the members page and the Share dialog (E10.8). The api answers with NAMES (last_owner, no_user, forbidden);
 * the person reads a sentence. Records over the whole vocabulary: a name added to the api's answers stops this file
 * compiling until it has words. Every email these sentences quote is rendered as text by the caller.
 */

/** Why a role change was refused, as the api's name for it. `gone`: the org vanished, or the caller is no longer a member. */
export type MemberRefusal = "no_user" | "last_owner" | "forbidden" | "gone";
const MEMBER_REFUSALS: Record<MemberRefusal, string> = {
  no_user: "Nobody has signed up with that email yet. Ask them to sign up first, then add them.",
  // The 409 last_owner, as a sentence: the org would be left with nobody to run it (F24).
  last_owner: "An organisation must keep at least one owner. Make someone else an owner before changing this role.",
  forbidden: "Only an owner of this organisation can add members or change roles.",
  gone: "This organisation cannot be found, or you are no longer a member of it.",
};
export const memberRefusalWords = (refusal: MemberRefusal): string => MEMBER_REFUSALS[refusal];

/** Why a share or a revoke was refused. A share is never `last_owner`: it is never owner (F25). */
export type ShareRefusal = "no_user" | "forbidden" | "gone";
const SHARE_REFUSALS: Record<ShareRefusal, string> = {
  no_user: "Nobody has signed up with that email yet. Ask them to sign up first, then share with them.",
  forbidden: "Only an owner of this document's organisation can share it or change who it is shared with.",
  gone: "This document cannot be found, or you can no longer open it.",
};
export const shareRefusalWords = (refusal: ShareRefusal): string => SHARE_REFUSALS[refusal];

/** What each role may do, in one line, for the legend beside the role controls. The same nesting as `includes` (F24). */
export const ROLE_WORDS: Record<Role, string> = {
  owner: "Runs the organisation: members and roles, sharing, AI usage and the audit trail, on top of everything an editor may do.",
  editor: "Edits documents, asks the AI and ships pull requests.",
  viewer: "Reads documents live; changes nothing.",
};
/** The roles as a form offers them, most limited first: the safe choice is the first one a person meets. */
export const ROLES_TO_OFFER: readonly Role[] = ["viewer", "editor", "owner"];

/** The caller's own role, read from the list they were given: the member list already carries it, so no route need say it twice. */
export const roleOf = (members: readonly Member[], userId: string | undefined): Role | undefined => members.find((m) => m.userId === userId)?.role;

/**
 * The list after the api answered a change: a member (or share) replaced by their new row, or added at the end; a revoked
 * one taken out. The list the page shows is the api's answer, never a guess made before it.
 */
export function withMember(members: readonly Member[], member: Member): Member[] {
  return members.some((m) => m.userId === member.userId) ? members.map((m) => (m.userId === member.userId ? member : m)) : [...members, member];
}
export const withoutMember = (members: readonly Member[], userId: string): Member[] => members.filter((m) => m.userId !== userId);
