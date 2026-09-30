import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

/**
 * The ONE door to every sandbox (noon-9gz). Sandboxes sit on --internal networks, one per document:
 * no egress, no host.docker.internal, no published port. This proxy is the only other member of each
 * of those networks, and the only published port (127.0.0.1, one per pool). It forwards
 * /preview/<document>/<token>/... unchanged to that document's dev server, and nothing else anywhere.
 *
 * The token is what a document id alone no longer opens: <nonce>.<mac>, the mac an HMAC of the document
 * and the nonce under a key only the worker and this proxy hold. The worker mints a fresh nonce for
 * every container it CREATES and makes <document>/<token> that dev server's base, so there are two
 * locks: this proxy refuses any token it did not see minted for that document (a guessed one, another
 * document's, a doc id with no token), and the sandbox refuses a token of an EARLIER container of the
 * same document (its base does not match: a bare 404). A preview URL lives as long as its container.
 *
 * Why not a hostname per document: the app is shown through ngrok's free plan, one hostname and no
 * wildcards (noon-l96), so every preview shares the canvas's origin anyway. What keeps pages apart is
 * the opaque-origin iframe and the sandbox's CORS lock on "null"; what keeps strangers out is this token.
 *
 * Runs INSIDE the proxy container (sandbox.ts hands this file to `node -e` in the sandbox image), so it
 * imports nothing but Node's own modules.
 */
const PATH = /^\/preview\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{16})\.([0-9a-f]{32})\//u;
/** A sandbox's dev server: its container name (sandbox.ts `sandboxName`), on the network the two share. */
const sandboxAt = (documentId: string): { host: string; port: number } => ({ host: `noon-sandbox-${documentId}`, port: 5173 });

const mac = (key: string, documentId: string, nonce: string): string => createHmac("sha256", key).update(`${documentId}/${nonce}`).digest("hex").slice(0, 32);

/** The path segment after the document id. `nonce` is 16 hex digits, fresh for every container. */
export const previewToken = (key: string, documentId: string, nonce: string): string => `${nonce}.${mac(key, documentId, nonce)}`;

/** The document a request may reach, or undefined when it may reach nothing. */
export function previewDocument(key: string, url: string): string | undefined {
  const [, documentId, nonce, given] = PATH.exec(url) ?? [];
  if (documentId === undefined || nonce === undefined || given === undefined) return undefined;
  return timingSafeEqual(Buffer.from(mac(key, documentId, nonce)), Buffer.from(given)) ? documentId : undefined;
}

/**
 * The sandbox's Vite accepts only a Host it knows (allowedHosts: localhost and IPs), not the public one
 * nor the container name. Everything else, Origin included (the CORS lock reads it), passes as sent.
 */
const HOST = "localhost:5173";

export function servePreviews({ key, port, upstream = sandboxAt }: { key: string; port: number; upstream?: (documentId: string) => { host: string; port: number } }): Server {
  if (key.length < 32) throw new Error("the preview key must be at least 32 characters");
  const server = createServer((req, res) => {
    const documentId = previewDocument(key, req.url ?? "");
    if (documentId === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const to = upstream(documentId);
    const forward = request({ ...to, method: req.method, path: req.url, headers: { ...req.headers, host: HOST } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    // A sandbox that is (re)starting, or gone: the canvas is already showing "rebuilding".
    forward.on("error", () => {
      if (!res.headersSent) res.statusCode = 502;
      res.end();
    });
    req.pipe(forward);
  });
  // The preview's HMR WebSocket: the same check, then the raw bytes both ways.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => { socket.destroy(); });
    const documentId = previewDocument(key, req.url ?? "");
    if (documentId === undefined) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const to = upstream(documentId);
    const forward = connect(to.port, to.host, () => {
      const headers: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() !== "host") headers.push(`${req.rawHeaders[i] ?? ""}: ${req.rawHeaders[i + 1] ?? ""}`);
      }
      forward.write(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\nHost: ${HOST}\r\n${headers.join("\r\n")}\r\n\r\n`);
      forward.write(head);
      forward.pipe(socket);
      socket.pipe(forward);
    });
    forward.on("error", () => { socket.destroy(); });
    socket.on("close", () => { forward.destroy(); });
  });
  server.listen(port);
  return server;
}
