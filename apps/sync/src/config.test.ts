import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const secret = "s".repeat(32);
const DATABASE_URL = "postgres://app:pw@db:5432/noon";
const MINIO = { MINIO_URL: "http://minio:9000", MINIO_USER: "noon", MINIO_PASSWORD: "p".repeat(48), REDIS_URL: "redis://redis:6379", SYNC_NODE_ID: "sync" }; // and Redis, for leases

test("the session secret is required, may be a rotation list, and every entry must be long enough", () => {
  expect(() => loadConfig({ DATABASE_URL, ...MINIO })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(() => loadConfig({ SESSION_TOKEN_SECRET: secret, ...MINIO })).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ SESSION_TOKEN_SECRET: secret, DATABASE_URL: "not-a-url", ...MINIO })).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: "short", ...MINIO })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(() => loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: `${secret},short`, ...MINIO })).toThrow(/SESSION_TOKEN_SECRET/);
  expect(loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: secret, ...MINIO })).toMatchObject({ databaseUrl: DATABASE_URL, secrets: [secret], port: 3001 });
  expect(loadConfig({ DATABASE_URL, SESSION_TOKEN_SECRET: `${"n".repeat(32)}, ${secret}`, PORT: "4000", ...MINIO })).toMatchObject({ secrets: ["n".repeat(32), secret], port: 4000 });
});

test("MinIO has no defaults for its address or credentials; the snapshot cadence has tunable defaults", () => {
  const base = { DATABASE_URL, SESSION_TOKEN_SECRET: secret };
  expect(() => loadConfig({ ...base, ...MINIO, MINIO_URL: undefined })).toThrow(/MINIO_URL/);
  expect(() => loadConfig({ ...base, ...MINIO, MINIO_URL: "minio:9000" })).toThrow(/MINIO_URL/);
  expect(() => loadConfig({ ...base, ...MINIO, MINIO_USER: "" })).toThrow(/MINIO_USER/);
  expect(() => loadConfig({ ...base, ...MINIO, MINIO_PASSWORD: undefined })).toThrow(/MINIO_PASSWORD/);
  expect(() => loadConfig({ ...base, ...MINIO, MINIO_PASSWORD: "hunter2hunter2" })).not.toThrow();
  expect(() => loadConfig({ ...base, ...MINIO, MINIO_PASSWORD: "leaked-password" })).not.toThrow(/leaked-password/);
  expect(loadConfig({ ...base, ...MINIO })).toMatchObject({
    minio: { endpoint: "http://minio:9000", accessKeyId: "noon", secretAccessKey: MINIO.MINIO_PASSWORD, bucket: "snapshots" },
    cadence: { everyOps: 500, everyMs: 30_000 },
  });
  expect(loadConfig({ ...base, ...MINIO, SNAPSHOT_EVERY_OPS: "50", SNAPSHOT_EVERY_SECONDS: "5" })).toMatchObject({ cadence: { everyOps: 50, everyMs: 5000 } });
  for (const bad of ["0", "-5", "1.5", "0x10", "ten"]) expect(() => loadConfig({ ...base, ...MINIO, SNAPSHOT_EVERY_OPS: bad })).toThrow(/SNAPSHOT_EVERY_OPS/);
  // noon-mo3.3.2: setInterval takes at most 2^31-1 ms; past it Node fires the timer every 1 ms instead.
  expect(loadConfig({ ...base, ...MINIO, SNAPSHOT_EVERY_SECONDS: "2147483" })).toMatchObject({ cadence: { everyMs: 2_147_483_000 } });
  expect(() => loadConfig({ ...base, ...MINIO, SNAPSHOT_EVERY_SECONDS: "2147484" })).toThrow(/SNAPSHOT_EVERY_SECONDS/);
});

test("a node needs Redis and an id its routing tables can name; the lease ttl is tunable", () => {
  const base = { DATABASE_URL, SESSION_TOKEN_SECRET: secret, ...MINIO };
  expect(() => loadConfig({ ...base, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
  expect(() => loadConfig({ ...base, SYNC_NODE_ID: undefined })).toThrow(/SYNC_NODE_ID/);
  for (const bad of ["", "Sync", "sync 2", "-sync", "a".repeat(33)]) expect(() => loadConfig({ ...base, SYNC_NODE_ID: bad }), bad).toThrow(/SYNC_NODE_ID/);
  expect(loadConfig(base)).toMatchObject({ lease: { redisUrl: "redis://redis:6379", nodeId: "sync", ttlMs: 10_000 } });
  expect(loadConfig({ ...base, SYNC_NODE_ID: "sync-2", LEASE_TTL_MS: "3000" })).toMatchObject({ lease: { nodeId: "sync-2", ttlMs: 3000 } });
});
