import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { Redis } from "ioredis";
import { TEST_REDIS_URL } from "../../queue/src/testing.ts";
import { createLeases } from "./index.ts";

const prefix = `test-lease-${randomUUID()}:`;
const TTL = 300;
// Separate connections, as separate sync processes would have: one client pipelines, and would hide a race.
const nodes = Array.from({ length: 8 }, () => createLeases({ redisUrl: TEST_REDIS_URL, ttlMs: TTL, prefix }));
const raw = new Redis(TEST_REDIS_URL);
afterAll(async () => {
  await Promise.all(nodes.map((each) => each.close()));
  const keys = await raw.keys(`${prefix}*`);
  if (keys.length > 0) await raw.del(...keys);
  await raw.quit();
});
const [a, b] = nodes as [typeof nodes[number], typeof nodes[number]];

test("N simultaneous acquires of a free room: exactly one wins, and the token counter moves by exactly one", async () => {
  await Promise.all(nodes.map((each) => each.ready()));
  const documentId = randomUUID();
  const results = await Promise.all(nodes.map((each, i) => each.acquire(documentId, `node-${String(i)}`)));
  const winners = results.filter((result) => result.acquired);
  expect(winners).toHaveLength(1);
  // Every loser was told who won, with the winner's token.
  for (const result of results) expect(result.holder).toEqual(winners[0]?.holder);
  expect(winners[0]?.holder.token).toBe(1);
  expect(await raw.get(`${prefix}lease-token:${documentId}`)).toBe("1");
  expect(await a.owner(documentId)).toEqual(winners[0]?.holder);
});

test("tokens rise strictly with each acquisition, across nodes and across the same node taking it again", async () => {
  const documentId = randomUUID();
  const first = await a.acquire(documentId, "sync");
  await a.release(documentId, first.holder);
  const second = await b.acquire(documentId, "sync-2");
  await b.release(documentId, second.holder);
  const third = await a.acquire(documentId, "sync");
  expect([first.holder.token, second.holder.token, third.holder.token]).toEqual([1, 2, 3]);
  expect([first.acquired, second.acquired, third.acquired]).toEqual([true, true, true]);
});

test("only the holder renews; a renewed lease outlives its first ttl; an expired one is anybody's", async () => {
  const documentId = randomUUID();
  const { holder } = await a.acquire(documentId, "sync");
  expect(await b.renew(documentId, { ...holder, nodeId: "sync-2" })).toBe(false); // another node
  expect(await b.renew(documentId, { ...holder, token: holder.token + 1 })).toBe(false); // same node, another acquisition
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, TTL / 3));
    expect(await a.renew(documentId, holder)).toBe(true);
  }
  expect((await b.acquire(documentId, "sync-2")).acquired).toBe(false); // 400 ms after the acquire: still held
  await new Promise((resolve) => setTimeout(resolve, TTL + 100));
  const next = await b.acquire(documentId, "sync-2");
  expect(next.acquired).toBe(true);
  expect(await a.renew(documentId, holder)).toBe(false); // the old holder cannot take it back by renewing
  expect(await a.owner(documentId)).toEqual(next.holder);
});

test("a late release by an old holder never deletes the next owner's lease", async () => {
  const documentId = randomUUID();
  const old = await a.acquire(documentId, "sync");
  await new Promise((resolve) => setTimeout(resolve, TTL + 100));
  const next = await b.acquire(documentId, "sync-2");
  await a.release(documentId, old.holder);
  expect(await a.owner(documentId)).toEqual(next.holder);
  await b.release(documentId, next.holder);
  expect(await a.owner(documentId)).toBeUndefined();
});

test("with Redis unreachable every call fails within the deadline instead of hanging", async () => {
  const away = createLeases({ redisUrl: "redis://127.0.0.1:1", timeoutMs: 300 });
  const started = Date.now();
  await expect(away.acquire(randomUUID(), "sync")).rejects.toThrow();
  await expect(away.owner(randomUUID())).rejects.toThrow();
  await expect(away.ready()).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(2000);
  await away.close();
});
