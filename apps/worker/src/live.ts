import type { Manifest } from "@noon/contracts";
import type { Job } from "@noon/db";
import { createLeases, syncRouter } from "@noon/lease";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";

/**
 * How THIS process reaches a document's room (not the browsers' address): one sync node's `syncUrl`, or, with
 * several nodes (E7.1), a `route` to whichever node owns the room. Asked before every connection, like /session.
 */
export type SyncSessions = { secret: string } & ({ syncUrl: string } | { route: (documentId: string) => Promise<string> });

export const roomUrl = (sessions: SyncSessions, documentId: string): Promise<string> =>
  "route" in sessions ? sessions.route(documentId) : Promise.resolve(`${sessions.syncUrl}/documents/${documentId}`);

/** SYNC_URL (config.ts) made usable: a table of nodes reads each room's owner from its lease in Redis. */
export function syncSessions(config: { secret: string } & ({ syncUrl: string } | { nodes: ReadonlyMap<string, string> }), redisUrl: string): { sessions: SyncSessions; close: () => Promise<void> } {
  if (!("nodes" in config)) return { sessions: config, close: () => Promise.resolve() };
  const leases = createLeases({ redisUrl });
  return { sessions: { secret: config.secret, route: syncRouter({ nodes: { kind: "many", nodes: config.nodes }, owner: (documentId) => leases.owner(documentId), alive: (nodeIds) => leases.alive(nodeIds) }) }, close: () => leases.close() };
}

/**
 * A peer in the job's document, signed for the person who made the job: it reads, and never submits anything
 * (the preview and Ship).
 */
export function readingPeer(job: Job, userId: string, sessions: SyncSessions, manifest: Manifest): ReturnType<typeof connectPeer> {
  return connectPeer({
    manifest,
    session: async () => ({
      wsUrl: await roomUrl(sessions, job.documentId),
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
