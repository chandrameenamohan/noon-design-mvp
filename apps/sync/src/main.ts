import { createDb } from "@noon/db";
import { createShutdown } from "@noon/process";
import { loadConfig } from "./config.ts";
import { startSyncServer } from "./server.ts";
import { s3Snapshots } from "./snapshots.ts";

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const snapshots = s3Snapshots(config.minio);
await snapshots.ensureBucket(); // fails the start, like a missing variable: a sync without MinIO cannot open a snapshotted document
const server = await startSyncServer({ port: config.port, secrets: config.secrets, store: db.documentStore(), snapshots, cadence: config.cadence });
process.stdout.write(`sync listening on ${server.url}\n`);

// Order matters: server.close() waits for the last snapshots in flight; only then may the pool go.
const shutdown = createShutdown({ steps: [() => server.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
