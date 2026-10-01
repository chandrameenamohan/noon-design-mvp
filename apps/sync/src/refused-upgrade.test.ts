import { connect } from "node:net";
import { afterEach, expect, test } from "vitest";
import { startSyncServer, type RunningSyncServer } from "./server.ts";

// noon-cs6.3 (Z.3 baseline, redis-wiped under load): a sync node was found dead with "Unhandled 'error' event ...
// read ECONNRESET ... on Socket instance". Node's http server hands a socket's errors over with the 'upgrade'
// event, and the handler listened for them only on the path that admits the peer. A connection refused with 401
// and then RESET by its client (a tab closed, a process killed, a scanner) had no listener: an uncaught exception,
// the end of the process, and with it every room on the node. No token is needed to do it.
let server: RunningSyncServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

/** An upgrade the node must refuse, then a TCP reset instead of a goodbye, `afterMs` after the request is written. */
const refusedThenReset = (port: number, path: string, afterMs: number): Promise<void> => new Promise((resolve) => {
  const socket = connect(port, "127.0.0.1", () => {
    socket.write(`GET ${path} HTTP/1.1\r\nHost: sync\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: noon.v1, not-a-token\r\n\r\n`, () => {
      setTimeout(() => { socket.resetAndDestroy(); resolve(); }, afterMs);
    });
  });
  socket.on("error", () => { resolve(); });
});

test("a refused upgrade whose client resets the connection does not take the node down", async () => {
  server = await startSyncServer({ port: 0, secrets: ["test-only-session-secret-0123456789abcdef"] });
  const port = Number(new URL(server.url).port);
  const uncaught: Error[] = [];
  const onUncaught = (err: Error): void => { uncaught.push(err); };
  process.on("uncaughtException", onUncaught);
  try {
    // Both orders of the race: the reset before the 401 is written, and after it.
    for (let i = 0; i < 20; i++) await refusedThenReset(port, i % 4 < 2 ? "/documents/11111111-1111-4111-8111-111111111111" : "/not-a-document", i % 2 === 0 ? 0 : 5);
    await new Promise((resolve) => setTimeout(resolve, 100)); // an error event is emitted a tick after the read
    expect(uncaught.map((err) => err.message)).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(200);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});
