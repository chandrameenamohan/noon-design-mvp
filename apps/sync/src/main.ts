import { createDb } from "@noon/db";
import { createLeases } from "@noon/lease";
import { createShutdown } from "@noon/process";
import { loadConfig } from "./config.ts";
import { startSyncServer } from "./server.ts";
import { s3Snapshots } from "./snapshots.ts";

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const snapshots = s3Snapshots(config.minio);
await snapshots.ensureBucket(); // fails the start, like a missing variable: a sync without MinIO cannot open a snapshotted document
// Not awaited to be ready: with Redis away this node still starts and answers "try again" (4503) until it returns.
const leases = createLeases({ redisUrl: config.lease.redisUrl, ttlMs: config.lease.ttlMs });
const server = await startSyncServer({ port: config.port, secrets: config.secrets, store: db.documentStore(), snapshots, cadence: config.cadence, lease: { leases, nodeId: config.lease.nodeId } });
process.stdout.write(`sync ${config.lease.nodeId} listening on ${server.url}\n`);

// Order matters: server.close() waits for the last snapshots in flight and releases the leases; only then may
// the pool and Redis go.
const shutdown = createShutdown({ steps: [() => server.close(), () => leases.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
