import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import { previewToken, servePreviews } from "./sandbox-proxy.ts";

// noon-9gz: the sandbox proxy, real HTTP, in front of a stand-in sandbox (no Docker: sandbox.int.test.ts
// runs it in its container). Proves the path passing unchanged, the Host the sandbox's Vite accepts,
// the HMR WebSocket, and that a request without the document's token dials nothing at all.
const key = "k".repeat(32);
const doc = "0b7e6a52-3c1d-4f8e-9a2b-5d6c7e8f9a0b";
const token = previewToken(key, doc, "0123456789abcdef");
const seen: { url: string; host: string; origin: string | undefined; upgrade: boolean; to: string }[] = [];
const dialled: string[] = [];
let sandbox: Server;
let proxy: Server;
let at = "";
const upgraded = new Set<Duplex>();

beforeAll(async () => {
  sandbox = createServer((req, res) => {
    seen.push({ url: req.url ?? "", host: req.headers.host ?? "", origin: req.headers.origin, upgrade: false, to: "" });
    res.setHeader("access-control-allow-origin", "null");
    res.end("from the sandbox");
  });
  // Just enough of RFC 6455's handshake for a client to call the socket open.
  sandbox.on("upgrade", (req, socket) => {
    seen.push({ url: req.url ?? "", host: req.headers.host ?? "", origin: req.headers.origin, upgrade: true, to: "" });
    upgraded.add(socket);
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => sandbox.listen(0, "127.0.0.1", resolve));
  const sandboxPort = (sandbox.address() as AddressInfo).port;
  proxy = servePreviews({ key, port: 0, upstream: (documentId) => { dialled.push(documentId); return { host: "127.0.0.1", port: sandboxPort }; } });
  await new Promise((resolve) => proxy.once("listening", resolve));
  at = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  for (const socket of upgraded) socket.destroy();
  proxy.closeAllConnections();
  sandbox.closeAllConnections();
  await Promise.all([new Promise((resolve) => proxy.close(resolve)), new Promise((resolve) => sandbox.close(resolve))]);
});

test("a request with the document's token reaches its sandbox, path and query unchanged, with a Host the sandbox's Vite accepts", async () => {
  const path = `/preview/${doc}/${token}/noon-preview/?doc=${doc}&started=1`;
  const res = await fetch(`${at}${path}`, { headers: { origin: "null" } });
  expect(await res.text()).toBe("from the sandbox");
  expect(res.headers.get("access-control-allow-origin")).toBe("null"); // the sandbox's CORS answer comes back as it was
  expect(seen.at(-1)).toMatchObject({ url: path, host: "localhost:5173", origin: "null", upgrade: false });
  expect(dialled.at(-1)).toBe(doc);
});

test("without the document's token it is a bare 404, and no sandbox is even dialled", async () => {
  const before = dialled.length;
  for (const path of [`/preview/${doc}/`, `/preview/${doc}/20001/`, `/preview/${doc}/0123456789abcdef.${"0".repeat(32)}/`, "/", "/api/health"]) {
    const res = await fetch(`${at}${path}`);
    expect(res.status, path).toBe(404);
    expect(await res.text(), path).toBe("");
  }
  expect(dialled.length).toBe(before);
});

test("the preview's HMR WebSocket rides the same door to the same sandbox, and without the token it does not open", async () => {
  const path = `/preview/${doc}/${token}/?token=t`;
  const socket = new WebSocket(`${at.replace("http", "ws")}${path}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.close();
  expect(seen.at(-1)).toMatchObject({ url: path, host: "localhost:5173", upgrade: true });

  const before = dialled.length;
  const refused = new WebSocket(`${at.replace("http", "ws")}/preview/${doc}/?token=t`);
  await new Promise((resolve, reject) => {
    refused.onopen = () => { reject(new Error("opened without the token")); };
    refused.onerror = resolve;
  });
  expect(dialled.length).toBe(before);
});

test("a sandbox that is not answering (restarting, reaped) is a 502, not a hung request", async () => {
  const down = servePreviews({ key, port: 0, upstream: () => ({ host: "127.0.0.1", port: 1 }) });
  await new Promise((resolve) => down.once("listening", resolve));
  try {
    expect((await fetch(`http://127.0.0.1:${String((down.address() as AddressInfo).port)}/preview/${doc}/${token}/`)).status).toBe(502);
  } finally {
    await new Promise((resolve) => down.close(resolve));
  }
});

test("a proxy with a guessable key refuses to start", () => {
  expect(() => servePreviews({ key: "short", port: 0 })).toThrow(/at least 32/u);
});
