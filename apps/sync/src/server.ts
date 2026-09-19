import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessage, type HealthResponse } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { emptyDoc } from "@noon/doc-model";
import { verifySessionToken } from "@noon/session-token";
import { frameText } from "./raw.ts";
import { createRoom, DEFAULT_LIMITS, type Peer, type Room, type RoomLimits } from "./room.ts";

export type RunningSyncServer = { url: string; close(): Promise<void> };

const PROTOCOL = "noon.v1";
const MAX_FRAME_BYTES = 64 * 1024; // an op is small; the contract caps props, this caps the frame before it is parsed
const CLOSE_INVALID_MESSAGE = 4400; // 4000-4999 are ours to define; mirrors HTTP 400
const DOCUMENT_PATH = /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function startSyncServer({ port, secrets, limits }: { port: number; secrets: readonly string[]; limits?: Partial<RoomLimits> }): Promise<RunningSyncServer> {
  const rooms = new Map<string, Room>();
  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", service: "sync" } satisfies HealthResponse));
      return;
    }
    res.writeHead(426, { "content-type": "application/json" }).end('{"error":"upgrade_required"}');
  });
  // noServer: WE decide, per request, whether a WebSocket exists at all. A bad token is answered
  // with a plain HTTP 401 and the connection is never upgraded.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, handleProtocols: (offered) => (offered.has(PROTOCOL) ? PROTOCOL : false) });

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const documentId = DOCUMENT_PATH.exec(new URL(req.url ?? "/", "http://sync").pathname)?.[1]?.toLowerCase();
    // The token is the second entry of Sec-WebSocket-Protocol: the one header a browser lets a page
    // set on a WebSocket. A query string would put the token in proxy logs and Referer headers.
    const [protocol, token] = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((part) => part.trim());
    const verified = documentId !== undefined && protocol === PROTOCOL && token !== undefined ? verifySessionToken({ token, secrets, documentId }) : undefined;
    if (documentId === undefined || !verified?.ok) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      serve(ws, documentId, verified.claims.userId);
    });
  });

  function serve(ws: WebSocket, documentId: string, userId: string): void {
    // ponytail: a room is created empty and lives in memory until the process ends. Loading and
    // saving the document arrives in E2.3b; dropping idle rooms with it.
    let room = rooms.get(documentId);
    if (!room) {
      room = createRoom({ doc: emptyDoc(), manifest, limits: { ...DEFAULT_LIMITS, ...limits } });
      rooms.set(documentId, room);
    }
    const joined = room;
    const peer: Peer = {
      actor: { kind: "user", id: userId },
      send: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };
    // Without an 'error' listener, a protocol error on ONE socket (an oversized frame, for one) would
    // be an uncaught exception and take the whole process down (learning-tests/ws).
    ws.on("error", () => undefined);
    ws.on("close", () => { joined.leave(peer); });
    ws.on("message", (data) => {
      let parsed;
      try {
        parsed = ClientMessage.safeParse(JSON.parse(frameText(data)));
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        ws.close(CLOSE_INVALID_MESSAGE, "invalid_message");
        return;
      }
      joined.submit(peer, parsed.data);
    });
    joined.join(peer);
  }

  return new Promise((resolve) => {
    http.listen(port, () => {
      const address = http.address() as AddressInfo;
      resolve({
        url: `ws://localhost:${String(address.port)}`,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            http.close(() => { done(); });
            http.closeAllConnections();
          }),
      });
    });
  });
}
