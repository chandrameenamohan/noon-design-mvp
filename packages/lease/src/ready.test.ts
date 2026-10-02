import { expect, test } from "vitest";
import { createLeases } from "./index.ts";

// noon-98h.1.2: every ready() that timed out left its 'ready' listener on the client, so a caller retrying against a
// slow Redis piled them up until Node warned of a leak (the eleventh). Nothing listens on port 1: Redis never answers.
test("ready() that times out leaves no listener behind, however often it is retried", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => { warnings.push(warning.name); };
  process.on("warning", onWarning);
  const leases = createLeases({ redisUrl: "redis://127.0.0.1:1", timeoutMs: 20 });
  try {
    for (let i = 0; i < 12; i++) await expect(leases.ready()).rejects.toThrow(/did not answer/);
    await new Promise((resolve) => setImmediate(resolve)); // a warning is emitted on a later tick
    expect(warnings).not.toContain("MaxListenersExceededWarning");
  } finally {
    process.off("warning", onWarning);
    await leases.close();
  }
});
