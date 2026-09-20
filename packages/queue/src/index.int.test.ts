import { expect, test } from "vitest";
import { createProducer, RedisUrl } from "./index.ts";

test("with Redis away, enqueue answers within its deadline instead of holding the caller for ever", async () => {
  const producer = createProducer({ redisUrl: "redis://127.0.0.1:1", timeoutMs: 300 }); // nothing listens on port 1
  const started = Date.now();
  await expect(producer.enqueue({ queue: "ai", jobId: crypto.randomUUID(), orgId: crypto.randomUUID() })).rejects.toThrow(/redis did not answer/);
  expect(Date.now() - started).toBeLessThan(1500);
  await producer.close();
});

test("REDIS_URL must be a redis URL with a host", () => {
  for (const bad of [undefined, "", "localhost:6379", "http://redis:6379", "redis://"]) expect(RedisUrl.safeParse(bad).success, String(bad)).toBe(false);
  for (const good of ["redis://redis:6379", "redis://:secret@localhost:6380", "rediss://cache.example.com"]) expect(RedisUrl.safeParse(good).success, good).toBe(true);
});
