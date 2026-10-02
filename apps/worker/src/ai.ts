import { createHash } from "node:crypto";
import type { Manifest, Op, Role, RunProgress, UsageAmount } from "@noon/contracts";
import type { Job } from "@noon/db";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { roomUrl, stableOpId, type SyncSessions } from "./live.ts";
import { withProgress } from "./progress.ts";
import type { RunAgent } from "./sdk.ts";
import { buildTools, type AgentPeer } from "./tools.ts";
import { JobFailure, requireEditor } from "./worker.ts";

export type { RunAgent };

/**
 * The ids a run mints, the same on every attempt of its job (F28): the n-th node is always the same id, and the n-th
 * op the same opId when it is the same op. A retry after a crash replays the dead attempt's steps first; a node it
 * finds already there is that step done, and an op the room journaled already gets its original answer (the
 * journal's key is (sender, opId)), so the document never holds anything twice. The op's content is in its id: a
 * model that does something ELSE at step n on the retry sends a new op, never one the room would take for the old.
 */
export function replayIds(jobId: string): { opId: (op: Op) => string; nodeId: () => string } {
  let ops = 0;
  let nodes = 0;
  const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
  return {
    opId: (op) => stableOpId(`${jobId}:op:${String(ops++)}:${JSON.stringify(op)}`),
    nodeId: () => `n_${digest(`${jobId}:node:${String(nodes++)}`).slice(0, 12)}`,
  };
}

/**
 * The same peer, except that the room's first `forbidden` calls `onForbidden`. It means the run's creator may no
 * longer edit (an owner made them a viewer during the run, noon-dtf.2.4): every op after it would be refused too, so
 * the run stops instead of spending more of the model on edits that cannot land. The tool still gets its answer.
 */
export function stopOnForbidden(peer: AgentPeer, onForbidden: () => void): AgentPeer {
  return {
    get doc() { return peer.doc; },
    submit(op) {
      const submitted = peer.submit(op);
      if (submitted.ok) void submitted.settled.then((outcome) => { if (!outcome.ok && outcome.reason === "forbidden") onForbidden(); });
      return submitted;
    },
  };
}

/**
 * One AI run: join the document as a peer, hand the model our tools, leave. The agent edits through
 * @noon/peer-client like a browser tab does (the single write path), so its ops get the same
 * validation, the same ordering, the same rate limit and the same rollback as a person's.
 */
export function createAiHandler({ sessions, manifest, oauthToken, runAgent, ready, roleOf, stopping, report, connectTimeoutMs = 10_000, runTimeoutMs = 5 * 60_000 }: {
  /** How THIS process reaches the document's room (inside Docker: ws://sync:3001), not the browsers' address. */
  sessions: SyncSessions;
  manifest: Manifest;
  oauthToken: string | undefined;
  runAgent: RunAgent;
  /** The startup probe of the SDK's tool list. Rejected = no run may start. */
  ready: Promise<void>;
  /** Asked when the run STARTS, which may be long after it was created: that user's role on the document now, undefined if none. */
  roleOf: (documentId: string, userId: string) => Promise<Role | undefined>;
  /** Aborted when the worker is told to stop (SIGTERM). */
  stopping: AbortSignal;
  /** F30: the run's steps so far, after every tool call. Given the job's `attempt`, so a stale attempt's steps land nowhere. */
  report: (job: Job & { attempt?: number }, progress: RunProgress) => Promise<void>;
  /** How long the sync server may be unreachable, at the start or in the middle of a run. */
  connectTimeoutMs?: number;
  /** The whole run, connect to last op. ponytail: one number for every run; per-org limits are F31 (E9). */
  runTimeoutMs?: number;
}): (job: Job & { attempt?: number }, cancelled: AbortSignal, spent?: (sofar: UsageAmount) => void) => Promise<UsageAmount> {
  return async (job, cancelled, spent = () => undefined) => {
    // Fail FAST and by name, before anything is connected or spent. A missing token does not make
    // the SDK throw: it answers with a polite "please log in", which would look like a run that
    // succeeded and did nothing (measured).
    if (oauthToken === undefined) throw new JobFailure("token_missing");
    await ready.catch(() => { throw new JobFailure("tools_missing"); });
    if (stopping.aborted) throw new JobFailure("worker_stopped");
    const userId = job.createdBy;
    // The session is signed for the person the run acts for. They were a member when they asked; a run can
    // wait in the queue, and being removed from the org must take effect on what has not started yet. So must being
    // made a viewer: the room would refuse every op, and the model's tokens would buy nothing (noon-dtf.2.4).
    if (userId === undefined) throw new JobFailure("owner_missing");
    requireEditor(await roleOf(job.documentId, userId));

    const ids = replayIds(job.id);
    const peer = connectPeer({
      manifest,
      mintOpId: ids.opId,
      // The worker holds the signing secret, so it mints its own session. The ROOM stamps every op
      // with this actor; nothing the agent sends can claim to be a person, or another run.
      session: async () => ({
        wsUrl: await roomUrl(sessions, job.documentId),
        token: signSessionToken({ userId, orgId: job.orgId, documentId: job.documentId, secret: sessions.secret, ttlSeconds: 60, actor: { kind: "agent", runId: job.id } }),
      }),
    });
    // A run must END, whatever happens around it. Left `running`, its row blocks this document's next
    // run for ever (one unfinished run per document) and holds one of the worker's few slots. So these
    // things can end it from outside (and the room's `forbidden`, below), each with a name the user can read; whichever comes first wins.
    const abort = new AbortController();
    let watchdog: NodeJS.Timeout | undefined;
    let end: (reason: string) => void = () => undefined;
    const ended = new Promise<never>((_, reject) => {
      end = (reason) => { reject(new JobFailure(reason)); };
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
    // One write at a time, in order: a later list never lands before an earlier one. A failed write is left: the next carries every step.
    let reporting = Promise.resolve();
    const tools = withProgress(buildTools(stopOnForbidden(peer, () => { end("forbidden"); }), manifest, ids.nodeId), (steps) => { reporting = reporting.then(() => report(job, { steps })).catch(() => undefined); });
    try {
      const live = (async () => {
        // `!abort.signal.aborted`: when the run ends first, this wait must end too (it ticked for ever: a closed peer is never "live").
        while (peer.status !== "live" && !abort.signal.aborted) await new Promise((r) => setTimeout(r, 20));
      })();
      await Promise.race([live, ended]);
      peer.setPresence({ cursor: null, selection: null }); // no pointer, but it tells the people already here that the AI has arrived
      const instruction = typeof job.input["instruction"] === "string" ? job.input["instruction"] : "";
      // `spent` goes straight to the worker: when `ended` wins below, the running total is all there is to record.
      const agent = runAgent({ instruction, tools, signal: abort.signal, spent });
      agent.catch(() => undefined); // if `ended` wins, the aborted agent rejects later, to nobody
      return await Promise.race([agent, ended]); // what the run consumed (F12): the worker records it
    } finally {
      clearInterval(watchdog);
      abort.abort(); // stops the model, and removes the listener on `stopping`
      peer.close(); // an op still waiting is answered `connection_closed`; everything the agent was told succeeded, did
      await reporting; // before the worker finishes the row: a step written after that would land nowhere (report needs `running`)
    }
  };
}
