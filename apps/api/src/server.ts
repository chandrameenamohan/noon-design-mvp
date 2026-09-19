import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { buildApp } from "./app.ts";

export type RunningServer = { url: string; close: () => Promise<void> };

/** Starts listening and resolves once the port is really open. */
export function startServer({ port }: { port: number }): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: buildApp().fetch, port }, (info: AddressInfo) => {
      resolve({
        url: `http://localhost:${String(info.port)}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => {
              if (err) fail(err);
              else done();
            });
          }),
      });
    });
  });
}
