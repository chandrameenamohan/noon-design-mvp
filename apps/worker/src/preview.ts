import { setTimeout as sleep } from "node:timers/promises";
import type { Manifest } from "@noon/contracts";
import type { Job } from "@noon/db";
import { generate } from "@noon/codegen";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { isRunning, previewUrl, pushPage, startSandbox, type SandboxOptions } from "./sandbox.ts";
import { JobFailure } from "./worker.ts";

/**
 * The `sandbox` queue's handler: keeps ONE document's preview in step with the document for as long
 * as somebody has that document open.
 *
 * It joins the room as a peer that never writes and never sets a presence, so the room never shows
 * it and never stamps anything with it. It projects from `peer.confirmed`, never from the optimistic
 * tree: that holds ops the server may still refuse, and a preview of a document that never existed
 * is worse than a preview a moment late.
 *
 * One loop, one tick. Each tick asks, in order: has the job been told to stop; has everyone left (end
 * as succeeded); is the container alive (if not, start it again and report where it now answers: the
 * port can change when another document took it while this one was down); has the confirmed document
 * moved since the last push (generate, push). A loop and not events: every one of those questions
 * needs a clock anyway, and a loop has exactly one place where it ends.
 */
export function createPreviewHandler({ sessions, manifest, sandbox, stopping, stillMember, reportUrl, tickMs = 100, paceMs = 300, aliveEveryMs = 1000, idleMs = 60_000 }: {
  /** `syncUrl` is how THIS process reaches the sync server, not the browsers' address. */
  sessions: { secret: string; syncUrl: string };
  manifest: Manifest;
  sandbox: Omit<SandboxOptions, "signal">;
  /** Aborted when the worker is told to stop (SIGTERM). */
  stopping: AbortSignal;
  /** Asked when the job STARTS, which may be long after it was created. */
  stillMember: (documentId: string, userId: string) => Promise<boolean>;
  /** Where the canvas learns the address to put in its iframe. Called again after every restart. */
  reportUrl: (job: Job, url: string) => Promise<void>;
  tickMs?: number;
  /** Pushes closer than this outrun the dev server's own file watcher (learning-tests/sandbox FINDINGS 2). */
  paceMs?: number;
  aliveEveryMs?: number;
  /** How long the document may have nobody in it before the preview stops following it. */
  idleMs?: number;
}): (job: Job, cancelled: AbortSignal) => Promise<undefined> {
  return async (job, cancelled) => {
    const userId = job.createdBy;
    if (userId === undefined || !(await stillMember(job.documentId, userId))) throw new JobFailure("owner_missing");
    const signal = AbortSignal.any([cancelled, stopping]);
    const options: SandboxOptions = { ...sandbox, signal };
    const start = async (): Promise<void> => {
      let url: string;
      try {
        ({ url } = await startSandbox(job.documentId, options));
      } catch (err) {
        // A stop during the start lands here too; the catch around the loop turns it into what it was.
        throw new JobFailure("sandbox_unavailable", err instanceof Error ? err.message : String(err));
      }
      await reportUrl(job, previewUrl(url, job.documentId));
    };
    const peer = connectPeer({
      manifest,
      // Signed for the person who opened the preview; it reads, and never submits anything.
      session: () => Promise.resolve({
        wsUrl: `${sessions.syncUrl}/documents/${job.documentId}`,
        token: signSessionToken({ userId, orgId: job.orgId, documentId: job.documentId, secret: sessions.secret, ttlSeconds: 60 }),
      }),
    });
    // Every way out of the loop below while the job is being stopped ends HERE, whatever docker call
    // it was in the middle of: cancelled = end quietly (the worker records `cancelled`), a stopping
    // worker = fail by name, as an AI run does, so the row says why the preview went away.
    const failIfStopping = (): void => {
      if (stopping.aborted) throw new JobFailure("worker_stopped");
    };
    try {
      await start();
      let pushedSeq = -1;
      let pushedAt = 0;
      let checkedAt = Date.now();
      let lastSeenSomeone = Date.now();
      for (;;) {
        if (signal.aborted) {
          failIfStopping();
          return undefined;
        }
        // Closed for good (the room refused it: 4404, 4500, a protocol error): `others` would stay frozen
        // as it was, and a job that still "sees" someone would hold its container for ever.
        if (peer.status === "closed") throw new JobFailure("sync_unreachable");
        const now = Date.now();
        if (peer.others.length > 0) lastSeenSomeone = now;
        if (now - lastSeenSomeone >= idleMs) return undefined;
        if (now - checkedAt >= aliveEveryMs) {
          checkedAt = now;
          if (!(await isRunning(job.documentId, options))) {
            await start();
            pushedSeq = -1; // a fresh clone holds the placeholder, not the document: push whatever the seq
          }
        }
        // ponytail: `paceMs` is the learning test's measured calibration, not logic: unpaced pushes
        // outran Vite's watcher in the browser, while the file itself was right. Tune, don't delete.
        if (peer.seq !== pushedSeq && now - pushedAt >= paceMs) {
          const seq = peer.seq;
          const generated = generate(peer.confirmed, manifest);
          // ponytail: a document that does not generate keeps the last good page on screen, and the
          // canvas is not told why. The reason is in `generated.reason` for when it should be.
          if (generated.ok) {
            try {
              await pushPage(job.documentId, generated.tsx, options);
            } catch (err) {
              // It died between the liveness check and the push (OOM, say): next tick brings it back,
              // and the push after that brings the page. Any other failure is a real one.
              if (await isRunning(job.documentId, options)) throw err; // a stop meanwhile throws here, and the catch below says which
              checkedAt = 0;
              continue;
            }
          }
          pushedSeq = seq;
          pushedAt = Date.now();
        }
        await sleep(tickMs, undefined, { signal }).catch(() => undefined);
      }
    } catch (err) {
      if (!signal.aborted) throw err;
      failIfStopping();
      return undefined;
    } finally {
      peer.close();
    }
  };
}
