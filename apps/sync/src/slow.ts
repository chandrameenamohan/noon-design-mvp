/**
 * Wraps the room's journal calls so that one slower than `thresholdMs` is reported, whether it succeeded or
 * failed; the result is the caller's either way. Every edit waits on these (an add waits on two), so a stall
 * a person feels (noon-ibo: one edit took 3 s to reach the other browser) shows in the log with its cause.
 */
export function reportSlow(thresholdMs: number, report: (what: string, ms: number) => void, now: () => number = () => performance.now()) {
  return <T>(what: string, work: Promise<T>): Promise<T> => {
    const started = now();
    return work.finally(() => {
      const took = Math.round(now() - started);
      if (took > thresholdMs) report(what, took);
    });
  };
}
