import type { Manifest } from "@noon/contracts";
import type { Job } from "@noon/db";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";

/**
 * A peer in the job's document, signed for the person who made the job: it reads, and never submits anything
 * (the preview and Ship). `syncUrl` is how THIS process reaches the sync server.
 */
export function readingPeer(job: Job, userId: string, sessions: { secret: string; syncUrl: string }, manifest: Manifest): ReturnType<typeof connectPeer> {
  return connectPeer({
    manifest,
    session: () => Promise.resolve({
      wsUrl: `${sessions.syncUrl}/documents/${job.documentId}`,
      token: signSessionToken({ userId, orgId: job.orgId, documentId: job.documentId, secret: sessions.secret, ttlSeconds: 60 }),
    }),
  });
}

/** `work`, or `reason` as an error once `ms` have passed. */
export async function within<T>(ms: number, reason: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(reason)); }, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once the peer is live (welcomed: `confirmed` is the room's document); rejects when the room closed it for good, or as `sync_unreachable` after `ms`. */
export async function whenLive(peer: Pick<ReturnType<typeof connectPeer>, "status" | "closedBecause">, ms: number): Promise<void> {
  let check: NodeJS.Timeout | undefined;
  await within(ms, "sync_unreachable", new Promise<void>((resolve, reject) => {
    check = setInterval(() => {
      if (peer.status === "live") resolve();
      else if (peer.closedBecause !== undefined) reject(new Error(`sync closed the peer: ${peer.closedBecause}`));
    }, 20);
  })).finally(() => { clearInterval(check); });
}
