import { createDb } from "@noon/db";
import { createLeases } from "@noon/lease";
import { createProducer } from "@noon/queue";
import { loadConfig } from "./config.ts";
import { chooseIdentity, devHeaderIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { createShutdown } from "@noon/process";

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const producer = createProducer({ redisUrl: config.redisUrl });
// Several sync nodes: /session reads each room's owner from its lease. One node: nothing to ask.
const leases = config.sessions.sync.kind === "many" ? createLeases({ redisUrl: config.redisUrl }) : undefined;
const identify = chooseIdentity(config.nodeEnv);
if (identify === devHeaderIdentity) {
  // A misconfigured deployment should at least be unmissable in its own logs.
  process.stderr.write("DEV IDENTITY: the x-dev-user header authenticates any caller. Never run this outside development.\n");
}
const server = await startServer({ port: config.port, db, identify, sessions: config.sessions, previewOrigin: config.previewOrigin, webhookSecret: config.webhookSecret, enqueue: producer.enqueue, ...(leases ? { owner: (documentId: string) => leases.owner(documentId), alive: (nodeIds: readonly string[]) => leases.alive(nodeIds) } : {}) });
process.stdout.write(`api listening on ${server.url} (${config.nodeEnv})\n`);

// SIGTERM is `docker stop`; SIGINT is Ctrl-C. Stop taking requests, then close the pool.
const shutdown = createShutdown({ steps: [() => server.close(), () => producer.close(), () => leases?.close() ?? Promise.resolve(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
