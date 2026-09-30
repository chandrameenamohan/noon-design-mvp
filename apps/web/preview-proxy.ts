import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ProxyOptions } from "vite";

/**
 * The running page through the canvas's OWN origin, for when the app is reached through one public URL
 * (a tunnel: noon-l96). The canvas frames https://<public host>/preview/<document>/<port>/noon-preview/,
 * and this forwards the path, unchanged, to the sandbox on that port of this machine's loopback. The
 * sandbox serves under exactly that path (its PREVIEW_BASE) and answers nothing else, so the port alone
 * reaches nothing: the document id is the key. HTTP and the preview's own HMR WebSocket alike.
 *
 * Only sandbox ports (apps/worker/src/sandbox.ts): anything else would make this a public door to every
 * service on the laptop's loopback (the api, Postgres, Redis).
 * ponytail: stateless, and anyone holding a document id sees its preview. Ceiling: fine for showing a
 * design through a tunnel; noon-9gz (a hostname per document, behind a real proxy) is the upgrade.
 */
const PATH = /^\/preview\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(\d{5})\//u;
const PORTS = [20000, 20999] as const;

/** Where a /preview/ request goes, or undefined when it may go nowhere. */
export function previewTarget(url: string): string | undefined {
  const port = Number(PATH.exec(url)?.[1]);
  return port >= PORTS[0] && port <= PORTS[1] ? `http://127.0.0.1:${String(port)}` : undefined;
}

export const previewProxy: Record<string, ProxyOptions> = {
  "^/preview/": {
    target: "http://127.0.0.1", // replaced for every request, below
    ws: true,
    // The sandbox's dev server accepts only its own Host (Vite's allowedHosts), not the public one.
    changeOrigin: true,
    // false = a bare 404, for HTTP and WebSocket alike, before any connection is made.
    bypass: (req) => (previewTarget(req.url ?? "") === undefined ? false : undefined),
    configure: (proxy) => {
      // Vite's proxy has one fixed target per rule; its http-proxy takes a target per call. The typings
      // call these readonly, but they are plain properties the proxy sets in its constructor.
      const web = proxy.web.bind(proxy);
      const ws = proxy.ws.bind(proxy);
      const to = (req: IncomingMessage): { target: string } => ({ target: previewTarget(req.url ?? "") ?? "" });
      Object.assign(proxy, {
        web: (req: IncomingMessage, res: ServerResponse) => { web(req, res, to(req)); },
        ws: (req: IncomingMessage, socket: Duplex, head: Buffer) => { ws(req, socket, head, to(req)); },
      });
    },
  },
};
