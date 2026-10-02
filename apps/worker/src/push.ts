import { parse } from "@noon/codegen";
import type { ConflictReason, Manifest } from "@noon/contracts";
import type { GitEvent, GitStore } from "@noon/db";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { WaitAgain, type ChangedPage, type PageBase } from "./git.ts";
import { roomUrl, stableOpId, whenLive, within, type SyncSessions } from "./live.ts";
import { pushOps } from "./push-ops.ts";

/**
 * E5.3b (F16a): a pushed generated page becomes ops on its open document. The git peer joins the
 * document through @noon/peer-client like a browser tab and the AI do (keystone 2, the ONE write path),
 * with a session whose actor is `git`: the room stamps every op with it, and with the commit as its run.
 *
 * Only the document's own branch (`noon/<id>`, the one the sandbox works on and Ship pushes) speaks for
 * it: the same file on main or on a feature branch would otherwise land twice, once per branch.
 *
 * Out of shape, another page's root, an id the page held before: a conflict, and NOTHING is sent (E5.4
 * shows it: keepConflict). Whatever the room then refuses op by op (a remove on the canvas won the race) is counted.
 */
export type PushOutcome =
  | { kind: "skipped"; why: "other_branch" | "no_document" | "shipped" }
  | { kind: "conflict"; reason: ConflictReason; detail: string }
  | { kind: "applied"; ops: number; refused: number };

export function createPushApplier({ sessions, manifest, documentOrg, shippedCommit, pushedNodeIds, connectTimeoutMs = 10_000, settleTimeoutMs = 30_000, WebSocketImpl }: {
  sessions: SyncSessions;
  manifest: Manifest;
  documentOrg: (documentId: string) => Promise<string | undefined>;
  /**
   * E5.5: did Ship make this commit? Its page is the document as it was when Ship read it, so it is skipped: the
   * three-way diff of it against the room would undo every canvas edit that raced the ship.
   */
  shippedCommit: (sha: string) => Promise<boolean>;
  /**
   * noon-91u: the node ids this commit already added to the document (the journal's git ops stamped with it). A push
   * applied again (its git peer was killed halfway, and the event resumed) finishes the page instead of taking its
   * own adds for re-used ids.
   */
  pushedNodeIds: (documentId: string, commit: string) => Promise<ReadonlySet<string>>;
  connectTimeoutMs?: number;
  /** How long the room may take to answer every op of one page. */
  settleTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
}): (event: GitEvent, page: ChangedPage, base: () => Promise<PageBase>) => Promise<PushOutcome> {
  return async (event, page, base) => {
    if (event.ref !== `refs/heads/noon/${page.documentId}`) return { kind: "skipped", why: "other_branch" };
    if (await shippedCommit(event.after)) return { kind: "skipped", why: "shipped" };
    if ("refused" in page) return { kind: "conflict", reason: page.refused, detail: page.path };
    const parsed = parse(page.tsx, manifest);
    if (!parsed.ok) return { kind: "conflict", reason: parsed.reason, detail: parsed.detail };
    const orgId = await documentOrg(page.documentId);
    if (orgId === undefined) return { kind: "skipped", why: "no_document" };
    const before = await base();
    const baseDoc = before.tsx === undefined ? undefined : parse(before.tsx, manifest);

    const peer = connectPeer({
      manifest,
      // Named by the commit and the op itself: the same push applied again sends its ops under their first ids, and the
      // room answers a repeat (a set_prop the canvas has changed since, included) with its first answer, not a second edit.
      mintOpId: (op) => stableOpId(`${event.after}:${page.documentId}:${JSON.stringify(op)}`),
      ...(WebSocketImpl ? { WebSocketImpl } : {}),
      // `sub` must be a uuid: the event's id. The commit rides as the run, so every op names the commit it came from.
      session: async () => ({
        wsUrl: await roomUrl(sessions, page.documentId),
        token: signSessionToken({ userId: event.id, orgId, documentId: page.documentId, secret: sessions.secret, ttlSeconds: 60, actor: { kind: "git", runId: event.after } }),
      }),
    });
    try {
      await whenLive(peer, connectTimeoutMs);
      // The CONFIRMED document: the base of the diff must be what the room holds, never a guess.
      // Asked once the room is live, so an add journaled before this peer joined is in the answer.
      const alreadyAdded = await pushedNodeIds(page.documentId, event.after);
      const result = pushOps({ base: baseDoc?.ok ? baseDoc.doc : undefined, target: parsed.doc, current: peer.confirmed, earlierIds: before.earlierIds, alreadyAdded });
      if (!result.ok) return { kind: "conflict", reason: result.reason, detail: result.detail };
      const settled = [];
      for (const op of result.ops) {
        const submitted = peer.submit(op);
        // E6.1b: the room cannot save. Not a conflict (the page is fine) and not a failure (the push would be
        // lost): the event waits. Ops of this page already sent die with the peer below, unapplied.
        if (!submitted.ok && submitted.reason === "read_only") throw new WaitAgain("document_read_only");
        // The replica refused it locally: the whole page was checked against this very document, so this is a bug; say so.
        if (!submitted.ok) throw new Error(`the git peer's own op was refused: ${submitted.reason}`);
        settled.push(submitted.settled);
      }
      const outcomes = await within(settleTimeoutMs, "sync_timeout", Promise.all(settled));
      return { kind: "applied", ops: result.ops.length, refused: outcomes.filter((outcome) => !outcome.ok).length };
    } finally {
      peer.close(); // an op still unanswered is settled `connection_closed`
    }
  };
}

/**
 * E5.4 (F16b): what the canvas's banner shows. A refused page is recorded with its commit and file, and it
 * replaces the conflict the document had; an applied one clears it, as the document's branch is back in
 * shape. So does Ship's own page (noon-wv8.6.1): the branch now holds the codegen byte for byte. Any other skipped
 * page (another branch, no document) says nothing about the document, so it changes nothing.
 * ponytail: only the NEWEST conflict is kept; ceiling: two refused pushes in a row show only the second;
 * upgrade: a row per event, if engineers ever need the list.
 */
export async function keepConflict(store: Pick<GitStore, "recordConflict" | "clearConflict">, event: GitEvent, page: ChangedPage, outcome: PushOutcome): Promise<void> {
  if (outcome.kind === "conflict") await store.recordConflict(page.documentId, { commit: event.after, file: page.path, reason: outcome.reason, detail: outcome.detail });
  else if (outcome.kind === "applied" || outcome.why === "shipped") await store.clearConflict(page.documentId);
}
