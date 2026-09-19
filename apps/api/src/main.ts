import { createDb } from "@noon/db";
import { loadConfig } from "./config.ts";
import { chooseIdentity, devHeaderIdentity } from "./identity.ts";
import { startServer } from "./server.ts";
import { createShutdown } from "./shutdown.ts";

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const identify = chooseIdentity(config.nodeEnv);
if (identify === devHeaderIdentity) {
  // A misconfigured deployment should at least be unmissable in its own logs.
  process.stderr.write("DEV IDENTITY: the x-dev-user header authenticates any caller. Never run this outside development.\n");
}
const server = await startServer({ port: config.port, db, identify });
process.stdout.write(`api listening on ${server.url} (${config.nodeEnv})\n`);

// SIGTERM is `docker stop`; SIGINT is Ctrl-C. Stop taking requests, then close the pool.
const shutdown = createShutdown({ steps: [() => server.close(), () => db.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
