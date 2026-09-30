import { ConflictReason, type AuditAction, type AuditEntry } from "@noon/contracts";
import { refusalSentence } from "./conflict.ts";

/**
 * What an audit entry says, as plain strings: the caller renders them as TEXT (an instruction, an email and a pushed
 * file name are what people typed). A Record over the WHOLE contract: an action added there stops this file compiling
 * until someone has written its sentence. Details are read defensively: an entry written before a detail existed
 * still reads as a sentence.
 */
const SENTENCES: Record<AuditAction, (d: Partial<Record<string, string>>) => string> = {
  signed_in: () => "Signed in.",
  role_changed: (d) => (d["previous"] === "none" ? `Added ${d["email"] ?? "someone"} as ${d["role"] ?? "a member"}.` : `Changed the role of ${d["email"] ?? "someone"} from ${d["previous"] ?? "?"} to ${d["role"] ?? "?"}.`),
  share_granted: (d) => `Shared a document with ${d["email"] ?? "someone"} as ${d["role"] ?? "?"}.`,
  share_revoked: (d) => `Revoked the share of ${d["email"] ?? "someone"}.`,
  run_started: (d) => `Started an AI run: “${d["instruction"] ?? ""}”`,
  ship_started: () => "Started a ship.",
  push_rejected: (d) => {
    const reason = ConflictReason.safeParse(d["reason"]);
    return `A push to ${d["file"] ?? "the page"} was not applied. ${reason.success ? refusalSentence(reason.data) : "It broke the page's rules."}`;
  },
};

export function auditWords(entry: AuditEntry): { who: string; what: string } {
  const who =
    entry.actor.kind === "user" ? (entry.actor.email ?? "A deleted user")
    : entry.actor.kind === "git" ? `Git, commit ${(entry.detail["commit"] ?? "").slice(0, 12)}`
    : "The system";
  return { who, what: SENTENCES[entry.action](entry.detail) };
}
