import { expect, test } from "vitest";
import { createProducer, describeError, RedisUrl } from "./index.ts";
import { TEST_REDIS_URL } from "./testing.ts";

// Node's default for an unhandled rejection is to END THE PROCESS: here that would be the api, mid-shutdown.
async function withoutUnhandledRejections(work: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const seen = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", seen);
  try {
    await work();
    await new Promise((r) => setTimeout(r, 200));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", seen);
  }
}

test("with Redis away, enqueue answers within its deadline instead of holding the caller for ever, and closing afterwards is clean", () =>
  withoutUnhandledRejections(async () => {
    const producer = createProducer({ redisUrl: "redis://127.0.0.1:1", timeoutMs: 300 }); // nothing listens on port 1
    const started = Date.now();
    await expect(producer.enqueue({ queue: "ai", jobId: crypto.randomUUID(), orgId: crypto.randomUUID() })).rejects.toThrow(/redis did not answer/);
    expect(Date.now() - started).toBeLessThan(1000);
    await producer.close(); // the abandoned add() fails NOW ("Connection is closed"): somebody must be holding that promise
  }));

test("with Redis slow, a deadline that wins and a close() in the middle of the handshake leave nothing behind", () =>
  withoutUnhandledRejections(async () => {
    const producer = createProducer({ redisUrl: TEST_REDIS_URL, prefix: "test-deadline", timeoutMs: 1 }); // real Redis, but never within 1 ms of a cold connection
    await expect(producer.enqueue({ queue: "ai", jobId: crypto.randomUUID(), orgId: crypto.randomUUID() })).rejects.toThrow(/redis did not answer/);
    await producer.close();
  }));

test("REDIS_URL must be a redis URL with a host", () => {
  for (const bad of [undefined, "", "localhost:6379", "http://redis:6379", "redis://"]) expect(RedisUrl.safeParse(bad).success, String(bad)).toBe(false);
  for (const good of ["redis://redis:6379", "redis://:secret@localhost:6380", "rediss://cache.example.com"]) expect(RedisUrl.safeParse(good).success, good).toBe(true);
});

test("ping answers with Redis there and fails within the deadline with Redis away", async () => {
  const up = createProducer({ redisUrl: TEST_REDIS_URL, prefix: "test-ping" });
  await expect(up.ping()).resolves.toBeUndefined();
  await up.close();
  const down = createProducer({ redisUrl: "redis://127.0.0.1:1", timeoutMs: 300 });
  await expect(down.ping()).rejects.toThrow(/redis did not answer/);
  await down.close();
});

test("an error with an empty message still says something in the log (a refused dual-stack connect is an AggregateError with message '')", () => {
  expect(describeError(new AggregateError([new Error("connect ECONNREFUSED ::1:1"), new Error("connect ECONNREFUSED 127.0.0.1:1")]))).toBe("connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1");
  expect(describeError(new Error("plain"))).toBe("plain");
  expect(describeError(new TypeError(""))).toBe("TypeError");
  expect(describeError("text")).toBe("text");
});
