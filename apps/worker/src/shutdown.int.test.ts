import { createServer, connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { TEST_REDIS_URL } from "../../../packages/queue/src/testing.ts";
import { createTestDb } from "../../../packages/db/src/testing.ts";
import { startWorker } from "./worker.ts";

/** Redis behind a wire the test can cut: the compose Redis is shared, so it cannot be stopped from here. */
async function cuttableRedis(): Promise<{ url: string; cut(): void }> {
  const real = new URL(TEST_REDIS_URL);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(real.port), real.hostname);
    for (const each of [client, upstream]) {
      sockets.add(each);
      each.on("error", () => undefined);
      each.on("close", () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unreachable");
  const url = new URL(TEST_REDIS_URL);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return { url: url.toString(), cut: () => { server.close(); for (const each of sockets) each.destroy(); } };
}

// Found by the E3.1 re-verify: `docker compose stop worker` with Redis down took 9 s and ended in
// exit code 1, because closing waited on a connection that was never coming back.
test("with Redis gone, a worker with nothing in flight still closes quickly", async () => {
  const db = await createTestDb();
  const redis = await cuttableRedis();
  try {
    const worker = await startWorker({ db: db.db, redisUrl: redis.url, prefix: `test-${randomBytes(6).toString("hex")}`, handlers: { ai: () => Promise.resolve(undefined) }, sweepMs: 60_000 });
    redis.cut();
    await new Promise((r) => setTimeout(r, 300)); // let the connections notice
    const started = Date.now();
    await worker.close();
    expect(Date.now() - started).toBeLessThan(5000); // main.ts allows 8 s before it gives up with exit 1
  } finally {
    await db.drop();
  }
});
