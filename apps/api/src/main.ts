import { createDb } from "@noon/db";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const server = await startServer({ port: config.port, db });
process.stdout.write(`api listening on ${server.url}\n`);

// Docker stops a container with SIGTERM: stop accepting requests, then close the pool.
process.on("SIGTERM", () => {
  void server
    .close()
    .then(() => db.close())
    .then(() => process.exit(0));
});
