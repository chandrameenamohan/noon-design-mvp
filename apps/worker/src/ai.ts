import type { Manifest } from "@noon/contracts";
import type { Job } from "@noon/db";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import type { RunAgent } from "./sdk.ts";
import { buildTools } from "./tools.ts";
import { JobFailure } from "./worker.ts";

export type { RunAgent };

/**
 * One AI run: join the document as a peer, hand the model our tools, leave. The agent edits through
 * @noon/peer-client like a browser tab does (the single write path), so its ops get the same
 * validation, the same ordering, the same rate limit and the same rollback as a person's.
 */
export function createAiHandler({ sessions, manifest, oauthToken, runAgent, ready, connectTimeoutMs = 10_000 }: {
  /** `syncUrl` is how THIS process reaches the sync server (inside Docker: ws://sync:3001), not the browsers' address. */
  sessions: { secret: string; syncUrl: string };
  manifest: Manifest;
  oauthToken: string | undefined;
  runAgent: RunAgent;
  /** The startup probe of the SDK's tool list. Rejected = no run may start. */
  ready: Promise<void>;
  connectTimeoutMs?: number;
}): (job: Job) => Promise<void> {
  return async (job) => {
    // Fail FAST and by name, before anything is connected or spent. A missing token does not make
    // the SDK throw: it answers with a polite "please log in", which would look like a run that
    // succeeded and did nothing (measured).
    if (oauthToken === undefined) throw new JobFailure("token_missing");
    await ready.catch(() => { throw new JobFailure("tools_missing"); });
    const userId = job.createdBy;
    if (userId === undefined) throw new JobFailure("owner_missing"); // the session is signed for the person the run acts for

    const peer = connectPeer({
      manifest,
      // The worker holds the signing secret, so it mints its own session. The ROOM stamps every op
      // with this actor; nothing the agent sends can claim to be a person, or another run.
      session: () => Promise.resolve({
        wsUrl: `${sessions.syncUrl}/documents/${job.documentId}`,
        token: signSessionToken({ userId, orgId: job.orgId, documentId: job.documentId, secret: sessions.secret, ttlSeconds: 60, actor: { kind: "agent", runId: job.id } }),
      }),
    });
    const abort = new AbortController();
    try {
      for (const deadline = Date.now() + connectTimeoutMs; peer.status !== "live"; await new Promise((r) => setTimeout(r, 20))) {
        // closedBecause, not status: a peer is "closed" for one tick before its first connection starts.
        if (peer.closedBecause !== undefined || Date.now() > deadline) throw new JobFailure("sync_unreachable");
      }
      peer.setPresence({ cursor: null, selection: null }); // no pointer, but it tells the people already here that the AI has arrived
      const instruction = typeof job.input["instruction"] === "string" ? job.input["instruction"] : "";
      await runAgent({ instruction, tools: buildTools(peer, manifest), signal: abort.signal });
    } finally {
      abort.abort();
      peer.close(); // every tool call has awaited its op's outcome, so nothing of ours is still in flight
    }
  };
}
