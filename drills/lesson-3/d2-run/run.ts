// DRILL 2 · one bug from Lesson 3 is planted in this file. Find it and fix it HERE.
//
// A run, cut down to the part that must END. The real one is apps/worker/src/ai.ts; the ideas are the
// same: three things can end a run from outside (the peer never connects or drops, the deadline, a
// cancel), each with a name the user can read, and whichever comes first wins. The peer here is a fake
// with a status; the model is whatever `runAgent` does.

export type FakePeer = { status: "connecting" | "live" | "closed"; closedBecause: string | undefined; close(): void };

/** Thrown to end a run with a reason the user may read. */
export class RunEnded extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function runOnce({ peer, runAgent, cancelled, connectTimeoutMs = 10_000, runTimeoutMs = 300_000 }: {
  peer: FakePeer;
  /** The model. Like the SDK's query(), it stops when the signal fires and rejects then. */
  runAgent: (signal: AbortSignal) => Promise<string>;
  /** Fired by the worker when the user pressed cancel. */
  cancelled: AbortSignal;
  /** How long the peer may be anything but live, at the start or in the middle. */
  connectTimeoutMs?: number;
  /** The whole run, connect to last op. */
  runTimeoutMs?: number;
}): Promise<string> {
  const abort = new AbortController();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  // Whichever comes first wins; each has a name. A promise that never resolves, only rejects.
  const ended = new Promise<never>((_, reject) => {
    const end = (reason: string): void => { reject(new RunEnded(reason)); };
    cancelled.addEventListener("abort", () => { end("cancelled"); }, { once: true, signal: abort.signal });
    const deadline = Date.now() + runTimeoutMs;
    let silentSince = Date.now();
    watchdog = setInterval(() => {
      if (peer.status === "live") silentSince = Date.now();
      if (peer.closedBecause !== undefined || Date.now() - silentSince > connectTimeoutMs) end("sync_unreachable");
      else if (Date.now() > deadline) end("timed_out");
    }, 10);
  });
  ended.catch(() => undefined); // when the agent finishes first, nobody is left to hear this one

  return (async () => {
    try {
      // Wait for the peer to be live before the model is started: its first tool call would fail otherwise.
      const live = (async () => {
        while (peer.status !== "live") await new Promise((r) => setTimeout(r, 20));
      })();
      await Promise.race([live, ended]);
      const agent = runAgent(abort.signal);
      agent.catch(() => undefined); // if `ended` wins, the aborted agent rejects later, to nobody
      return await Promise.race([agent, ended]);
    } finally {
      clearInterval(watchdog);
      abort.abort(); // stops the model, and removes the listener on `cancelled`
      peer.close();
    }
  })();
}
