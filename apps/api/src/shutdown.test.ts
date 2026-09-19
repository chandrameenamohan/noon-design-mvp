import { expect, test } from "vitest";
import { createShutdown } from "./shutdown.ts";

const never = (): Promise<void> => new Promise(() => undefined);

test("closes each step in order, then exits 0", async () => {
  const calls: string[] = [];
  const exits: number[] = [];
  const shutdown = createShutdown({
    steps: [() => Promise.resolve(void calls.push("http")), () => Promise.resolve(void calls.push("db"))],
    timeoutMs: 1000,
    exit: (code) => exits.push(code),
  });
  await shutdown();
  expect(calls).toEqual(["http", "db"]);
  expect(exits).toEqual([0]);
});

test("a second signal while shutting down is ignored instead of crashing the process", async () => {
  let closes = 0;
  const exits: number[] = [];
  const shutdown = createShutdown({
    steps: [() => (++closes > 1 ? Promise.reject(new Error("ERR_SERVER_NOT_RUNNING")) : Promise.resolve())],
    timeoutMs: 1000,
    exit: (code) => exits.push(code),
  });
  await Promise.all([shutdown(), shutdown()]);
  expect(closes).toBe(1);
  expect(exits).toEqual([0]);
});

test("a step that fails or hangs cannot keep the process alive past the deadline", async () => {
  const failing: number[] = [];
  await createShutdown({ steps: [() => Promise.reject(new Error("pool busy"))], timeoutMs: 1000, exit: (c) => failing.push(c) })();
  expect(failing).toEqual([1]);

  const hanging: number[] = [];
  const started = Date.now();
  await createShutdown({ steps: [never], timeoutMs: 50, exit: (c) => hanging.push(c) })();
  expect(hanging).toEqual([1]);
  expect(Date.now() - started).toBeLessThan(1000);
});
