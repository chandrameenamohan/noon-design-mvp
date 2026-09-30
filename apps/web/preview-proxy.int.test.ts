import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { previewProxy } from "./preview-proxy.ts";

// noon-l96: the canvas's REAL dev server with the /preview/ rule, in front of a stand-in sandbox on a
// sandbox port. Proves the per-request target (the rule's own target is a placeholder), the path passing
// through unchanged, the Host the sandbox accepts, and the HMR WebSocket riding the same rule.
const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";
const seen: { url: string; host: string; upgrade: boolean }[] = [];
let sandbox: Server;
let sandboxPort = 0;
let vite: ViteDevServer;
let canvas = "";
const upgraded = new Set<Duplex>();

/** A free port in the sandbox range: the proxy refuses every other one. */
async function listenInRange(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 1000);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => { resolve(false); });
      server.listen(port, "127.0.0.1", () => { resolve(true); });
    });
    if (ok) return port;
  }
  throw new Error("no free port in the sandbox range");
}

beforeAll(async () => {
  sandbox = createHttpServer((req, res) => {
    seen.push({ url: req.url ?? "", host: req.headers.host ?? "", upgrade: false });
    res.end("from the sandbox");
  });
  // Just enough of RFC 6455's handshake for a client to call the socket open.
  sandbox.on("upgrade", (req, socket) => {
    seen.push({ url: req.url ?? "", host: req.headers.host ?? "", upgrade: true });
    upgraded.add(socket);
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  sandboxPort = await listenInRange(sandbox);
  vite = await createServer({ configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1", proxy: previewProxy } });
  await vite.listen();
  canvas = `http://127.0.0.1:${String((vite.httpServer?.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await vite.close();
  for (const socket of upgraded) socket.destroy(); // close() waits for every socket, and these are no longer the server's
  sandbox.closeAllConnections();
  await new Promise((resolve) => sandbox.close(resolve));
});

test("a preview request reaches the port it names, path and query unchanged, with the sandbox's own Host", async () => {
  const path = `/preview/${doc}/${String(sandboxPort)}/noon-preview/?doc=${doc}&started=1`;
  const res = await fetch(`${canvas}${path}`);
  expect(await res.text()).toBe("from the sandbox");
  expect(seen.at(-1)).toEqual({ url: path, host: `127.0.0.1:${String(sandboxPort)}`, upgrade: false });
});

test("a port outside the sandbox range is a 404, and nothing is dialled", async () => {
  const before = seen.length;
  for (const port of ["03000", "05432", "21000"]) {
    expect((await fetch(`${canvas}/preview/${doc}/${port}/`)).status, port).toBe(404);
  }
  expect(seen.length).toBe(before);
});

test("the preview's HMR WebSocket rides the same rule to the same sandbox", async () => {
  const path = `/preview/${doc}/${String(sandboxPort)}/?token=t`;
  const socket = new WebSocket(`${canvas.replace("http", "ws")}${path}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.close();
  expect(seen.at(-1)).toEqual({ url: path, host: `127.0.0.1:${String(sandboxPort)}`, upgrade: true });
});
