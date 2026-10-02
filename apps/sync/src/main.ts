import { createDb } from "@noon/db";
import { accessSubscriber, createLeases } from "@noon/lease";
import { createShutdown } from "@noon/process";
import { loadConfig } from "./config.ts";
import { startSyncServer } from "./server.ts";
import { s3Snapshots } from "./snapshots.ts";

const config = loadConfig(process.env);
// noon-cs6.3.2: an open is a few reads in a row, each bounded; on a slow Postgres a fresh connection's handshake alone
// could run past the bound, so one connection stays open, opened now rather than by the first peer.
// ponytail: one warm; ceiling: reads at the same instant (two opens, a sweep) still open more; upgrade: warm = that count.
const db = createDb({ connectionString: config.databaseUrl, warm: 1 });
void db.ping().catch(() => undefined); // Postgres away: the first read connects instead
const snapshots = s3Snapshots(config.minio);
await snapshots.ensureBucket(); // fails the start, like a missing variable: a sync without MinIO cannot open a snapshotted document
// Not awaited to be ready: with Redis away this node still starts and answers "try again" (4503) until it returns.
const leases = createLeases({ redisUrl: config.lease.redisUrl, ttlMs: config.lease.ttlMs });
const server = await startSyncServer({ port: config.port, secrets: config.secrets, store: db.documentStore(), snapshots, cadence: config.cadence, lease: { leases, nodeId: config.lease.nodeId }, roles: (orgId, documentId, userId) => db.roleIn(orgId, documentId, userId) });
// E8.2 (F24): the api announces role changes on Redis; every live session they concern reads its role again.
const access = accessSubscriber({ redisUrl: config.lease.redisUrl, onChange: (change) => void server.recheck(change) });
process.stdout.write(`sync ${config.lease.nodeId} listening on ${server.url}\n`);

// Order matters: server.close() waits for the last snapshots in flight and releases the leases; only then may
// the pool and Redis go.
const shutdown = createShutdown({ steps: [() => access.close(), () => server.close(), () => leases.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
