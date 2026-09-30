import { parse } from "@noon/codegen";
import type { ConflictReason, Manifest } from "@noon/contracts";
import type { GitEvent, GitStore } from "@noon/db";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import type { ChangedPage, PageBase } from "./git.ts";
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
  | { kind: "skipped"; why: "other_branch" | "no_document" }
  | { kind: "conflict"; reason: ConflictReason; detail: string }
  | { kind: "applied"; ops: number; refused: number };

export function createPushApplier({ sessions, manifest, documentOrg, connectTimeoutMs = 10_000, settleTimeoutMs = 30_000, WebSocketImpl }: {
  /** `syncUrl` is how THIS process reaches the sync server. */
  sessions: { secret: string; syncUrl: string };
  manifest: Manifest;
  documentOrg: (documentId: string) => Promise<string | undefined>;
  connectTimeoutMs?: number;
  /** How long the room may take to answer every op of one page. */
  settleTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
}): (event: GitEvent, page: ChangedPage, base: () => Promise<PageBase>) => Promise<PushOutcome> {
  return async (event, page, base) => {
    if (event.ref !== `refs/heads/noon/${page.documentId}`) return { kind: "skipped", why: "other_branch" };
    if ("refused" in page) return { kind: "conflict", reason: page.refused, detail: page.path };
    const parsed = parse(page.tsx, manifest);
    if (!parsed.ok) return { kind: "conflict", reason: parsed.reason, detail: parsed.detail };
    const orgId = await documentOrg(page.documentId);
    if (orgId === undefined) return { kind: "skipped", why: "no_document" };
    const before = await base();
    const baseDoc = before.tsx === undefined ? undefined : parse(before.tsx, manifest);

    const peer = connectPeer({
      manifest,
      ...(WebSocketImpl ? { WebSocketImpl } : {}),
      // `sub` must be a uuid: the event's id. The commit rides as the run, so every op names the commit it came from.
      session: () => Promise.resolve({
        wsUrl: `${sessions.syncUrl}/documents/${page.documentId}`,
        token: signSessionToken({ userId: event.id, orgId, documentId: page.documentId, secret: sessions.secret, ttlSeconds: 60, actor: { kind: "git", runId: event.after } }),
      }),
    });
    try {
      let check: NodeJS.Timeout | undefined;
      await within(connectTimeoutMs, "sync_unreachable", new Promise<void>((resolve, reject) => {
        check = setInterval(() => {
          if (peer.status === "live") resolve();
          else if (peer.closedBecause !== undefined) reject(new Error(`sync closed the git peer: ${peer.closedBecause}`));
        }, 20);
      })).finally(() => { clearInterval(check); });
      // The CONFIRMED document: the base of the diff must be what the room holds, never a guess.
      const result = pushOps({ base: baseDoc?.ok ? baseDoc.doc : undefined, target: parsed.doc, current: peer.confirmed, earlierIds: before.earlierIds });
      if (!result.ok) return { kind: "conflict", reason: result.reason, detail: result.detail };
      const settled = [];
      for (const op of result.ops) {
        const submitted = peer.submit(op);
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
 * shape. A skipped page (another branch, no document) says nothing about the document, so it changes nothing.
 * ponytail: only the NEWEST conflict is kept; ceiling: two refused pushes in a row show only the second;
 * upgrade: a row per event, if engineers ever need the list.
 */
export async function keepConflict(store: Pick<GitStore, "recordConflict" | "clearConflict">, event: GitEvent, page: ChangedPage, outcome: PushOutcome): Promise<void> {
  if (outcome.kind === "conflict") await store.recordConflict(page.documentId, { commit: event.after, file: page.path, reason: outcome.reason, detail: outcome.detail });
  else if (outcome.kind === "applied") await store.clearConflict(page.documentId);
}

async function within<T>(ms: number, reason: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(reason)); }, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
