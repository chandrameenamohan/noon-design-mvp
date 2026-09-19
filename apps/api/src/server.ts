import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Db } from "@noon/db";
import { buildApp } from "./app.ts";

export type RunningServer = { url: string; close: () => Promise<void> };

/** Starts listening and resolves once the port is really open. */
export function startServer({ port, db }: { port: number; db: Db }): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: buildApp({ db }).fetch, port }, (info: AddressInfo) => {
      // A client that opens a request and never finishes it must not hold a socket for Node's
      // default 5 minutes. (Bodies are capped at 64 KB, so 30 s is generous.)
      if ("requestTimeout" in server) {
        server.requestTimeout = 30_000;
        server.headersTimeout = 10_000;
      }
      resolve({
        url: `http://localhost:${String(info.port)}`,
        close: () =>
          new Promise<void>((done, fail) => {
            // close() waits for open sockets; idle keep-alive ones would hold it for seconds.
            if ("closeIdleConnections" in server) server.closeIdleConnections();
            server.close((err) => {
              if (err) fail(err);
              else done();
            });
          }),
      });
    });
  });
}
