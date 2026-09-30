import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { previewProxy } from "./preview-proxy.ts";

// noon-l96: the canvas's REAL dev server with the /preview/ rule, in front of a stand-in for the stack's
// sandbox proxy (noon-9gz: that one checks the token, apps/worker/src/sandbox-proxy.int.test.ts). Proves
// the path passing through unchanged, and the HMR WebSocket riding the same rule.
const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";
const token = `0123456789abcdef.${"a".repeat(32)}`;
const seen: { url: string; upgrade: boolean }[] = [];
let sandbox: Server;
let sandboxPort = 0;
let vite: ViteDevServer;
let canvas = "";
const upgraded = new Set<Duplex>();

beforeAll(async () => {
  sandbox = createHttpServer((req, res) => {
    seen.push({ url: req.url ?? "", upgrade: false });
    res.end("from the sandbox");
  });
  // Just enough of RFC 6455's handshake for a client to call the socket open.
  sandbox.on("upgrade", (req, socket) => {
    seen.push({ url: req.url ?? "", upgrade: true });
    upgraded.add(socket);
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => sandbox.listen(0, "127.0.0.1", resolve));
  sandboxPort = (sandbox.address() as AddressInfo).port;
  vite = await createServer({ configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1", proxy: previewProxy(`http://127.0.0.1:${String(sandboxPort)}`) } });
  await vite.listen();
  canvas = `http://127.0.0.1:${String((vite.httpServer?.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await vite.close();
  for (const socket of upgraded) socket.destroy(); // close() waits for every socket, and these are no longer the server's
  sandbox.closeAllConnections();
  await new Promise((resolve) => sandbox.close(resolve));
});

test("a preview request reaches the sandbox proxy, path and query unchanged", async () => {
  const path = `/preview/${doc}/${token}/noon-preview/?doc=${doc}&started=1`;
  const res = await fetch(`${canvas}${path}`);
  expect(await res.text()).toBe("from the sandbox");
  expect(seen.at(-1)).toEqual({ url: path, upgrade: false });
});

test("the preview's HMR WebSocket rides the same rule to the same place", async () => {
  const path = `/preview/${doc}/${token}/?token=t`;
  const socket = new WebSocket(`${canvas.replace("http", "ws")}${path}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.close();
  expect(seen.at(-1)).toEqual({ url: path, upgrade: true });
});
