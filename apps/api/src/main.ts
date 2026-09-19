import { createDb } from "@noon/db";
import { loadConfig } from "./config.ts";
import { chooseIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { createShutdown } from "./shutdown.ts";

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const server = await startServer({ port: config.port, db, identify: chooseIdentity(config.nodeEnv) });
process.stdout.write(`api listening on ${server.url} (${config.nodeEnv})\n`);

// SIGTERM is `docker stop`; SIGINT is Ctrl-C. Stop taking requests, then close the pool.
const shutdown = createShutdown({ steps: [() => server.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
