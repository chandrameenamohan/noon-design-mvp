/**
 * Builds the signal handler. Runs the steps in order, once, and always ends the process:
 * exit 0 when everything closed, exit 1 when a step failed or the deadline passed. Docker sends
 * SIGKILL 10 s after SIGTERM, so the deadline must be shorter than that to stay in control.
 */
export function createShutdown({ steps, timeoutMs, exit }: {
  steps: (() => Promise<void>)[];
  timeoutMs: number;
  exit: (code: number) => void;
}): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<"late">((resolve) => {
        timer = setTimeout(() => { resolve("late"); }, timeoutMs);
      });
      const work = (async () => {
        for (const step of steps) await step();
        return "done" as const;
      })().catch(() => "failed" as const);
      const outcome = await Promise.race([work, deadline]);
      clearTimeout(timer);
      exit(outcome === "done" ? 0 : 1);
    })());
}
