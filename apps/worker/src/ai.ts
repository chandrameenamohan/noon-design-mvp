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
export function createAiHandler({ sessions, manifest, oauthToken, runAgent, ready, stillMember, stopping, connectTimeoutMs = 10_000, runTimeoutMs = 5 * 60_000 }: {
  /** `syncUrl` is how THIS process reaches the sync server (inside Docker: ws://sync:3001), not the browsers' address. */
  sessions: { secret: string; syncUrl: string };
  manifest: Manifest;
  oauthToken: string | undefined;
  runAgent: RunAgent;
  /** The startup probe of the SDK's tool list. Rejected = no run may start. */
  ready: Promise<void>;
  /** Asked when the run STARTS, which may be long after it was created: is that user still a member of the document's org? */
  stillMember: (documentId: string, userId: string) => Promise<boolean>;
  /** Aborted when the worker is told to stop (SIGTERM). */
  stopping: AbortSignal;
  /** How long the sync server may be unreachable, at the start or in the middle of a run. */
  connectTimeoutMs?: number;
  /** The whole run, connect to last op. ponytail: one number for every run; per-org limits are F31 (E9). */
  runTimeoutMs?: number;
}): (job: Job, cancelled: AbortSignal) => Promise<void> {
  return async (job, cancelled) => {
    // Fail FAST and by name, before anything is connected or spent. A missing token does not make
    // the SDK throw: it answers with a polite "please log in", which would look like a run that
    // succeeded and did nothing (measured).
    if (oauthToken === undefined) throw new JobFailure("token_missing");
    await ready.catch(() => { throw new JobFailure("tools_missing"); });
    if (stopping.aborted) throw new JobFailure("worker_stopped");
    const userId = job.createdBy;
    // The session is signed for the person the run acts for. They were a member when they asked; a run can
    // wait in the queue, and being removed from the org must take effect on what has not started yet.
    if (userId === undefined || !(await stillMember(job.documentId, userId))) throw new JobFailure("owner_missing");

    const peer = connectPeer({
      manifest,
      // The worker holds the signing secret, so it mints its own session. The ROOM stamps every op
      // with this actor; nothing the agent sends can claim to be a person, or another run.
      session: () => Promise.resolve({
        wsUrl: `${sessions.syncUrl}/documents/${job.documentId}`,
        token: signSessionToken({ userId, orgId: job.orgId, documentId: job.documentId, secret: sessions.secret, ttlSeconds: 60, actor: { kind: "agent", runId: job.id } }),
      }),
    });
    // A run must END, whatever happens around it. Left `running`, its row blocks this document's next
    // run for ever (one unfinished run per document) and holds one of the worker's few slots. So three
    // things can end it from outside, each with a name the user can read; whichever comes first wins.
    const abort = new AbortController();
    let watchdog: NodeJS.Timeout | undefined;
    const ended = new Promise<never>((_, reject) => {
      const end = (reason: string): void => { reject(new JobFailure(reason)); };
      stopping.addEventListener("abort", () => { end("worker_stopped"); }, { once: true, signal: abort.signal });
      cancelled.addEventListener("abort", () => { end("cancelled"); }, { once: true, signal: abort.signal }); // F10: the ops already applied stay // SIGTERM: say so NOW, inside the shutdown deadline
      const deadline = Date.now() + runTimeoutMs;
      let silentSince = Date.now();
      watchdog = setInterval(() => {
        if (peer.status === "live") silentSince = Date.now();
        // peer-client retries a lost server for ever, and an op it cannot send is never answered: the tool
        // call waiting on it would never return. Closing the peer (below) answers it: connection_closed.
        if (peer.closedBecause !== undefined || Date.now() - silentSince > connectTimeoutMs) end("sync_unreachable");
        else if (Date.now() > deadline) end("timed_out");
      }, 50);
    });
    ended.catch(() => undefined); // when the agent finishes first, nobody is left to hear this one
    try {
      const live = (async () => {
        // `!abort.signal.aborted`: when the run ends first, this wait must end too (it ticked for ever: a closed peer is never "live").
        while (peer.status !== "live" && !abort.signal.aborted) await new Promise((r) => setTimeout(r, 20));
      })();
      await Promise.race([live, ended]);
      peer.setPresence({ cursor: null, selection: null }); // no pointer, but it tells the people already here that the AI has arrived
      const instruction = typeof job.input["instruction"] === "string" ? job.input["instruction"] : "";
      const agent = runAgent({ instruction, tools: buildTools(peer, manifest), signal: abort.signal });
      agent.catch(() => undefined); // if `ended` wins, the aborted agent rejects later, to nobody
      await Promise.race([agent, ended]);
    } finally {
      clearInterval(watchdog);
      abort.abort(); // stops the model, and removes the listener on `stopping`
      peer.close(); // an op still waiting is answered `connection_closed`; everything the agent was told succeeded, did
    }
  };
}
