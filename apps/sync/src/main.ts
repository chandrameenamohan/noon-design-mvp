import { createShutdown } from "@noon/process";
import { loadConfig } from "./config.ts";
import { startSyncServer } from "./server.ts";

const config = loadConfig(process.env);
const server = await startSyncServer({ port: config.port, secrets: config.secrets });
process.stdout.write(`sync listening on ${server.url}\n`);

const shutdown = createShutdown({ steps: [() => server.close()], timeoutMs: 8000, exit: (code) => process.exit(code) });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
