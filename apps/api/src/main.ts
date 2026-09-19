import { startServer } from "./server.ts";

const port = Number(process.env["PORT"] ?? 3000);
const server = await startServer({ port });
process.stdout.write(`api listening on ${server.url}\n`);

// Docker stops a container with SIGTERM; close the listener so in-flight requests can finish.
process.on("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});
