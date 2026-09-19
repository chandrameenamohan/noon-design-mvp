import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { ClientMessage, type HealthResponse } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import { manifest } from "@noon/design-system";
import { checkDoc, emptyDoc } from "@noon/doc-model";
import { verifySessionToken } from "@noon/session-token";
import { frameText } from "./raw.ts";
import { createRoom, type Peer, type Room, type RoomLimits } from "./room.ts";

export type RunningSyncServer = {
  url: string;
  close(): Promise<void>;
  /** Resolves when no document save is in flight. */
  idle(): Promise<void>;
  peerCount(documentId: string): number;
  roomCount(): number;
};

const PROTOCOL = "noon.v1";
const MAX_FRAME_BYTES = 64 * 1024; // an op is small; the contract caps props, this caps the frame BEFORE it is parsed
const TOKEN_LEEWAY_SECONDS = 5; // the api signs, this process verifies: two clocks never agree exactly
const DOCUMENT_PATH = /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// 4000-4999 are ours to define. They mirror the HTTP status a REST call would have had.
const CLOSE = { invalidMessage: 4400, documentNotFound: 4404, documentCorrupt: 4500, unavailable: 4503 } as const;

type Options = {
  port: number;
  secrets: readonly string[];
  limits?: Partial<RoomLimits>;
  /** Where documents are loaded from and saved to. Without one, rooms start empty and nothing is kept. */
  store?: DocumentStore;
  /** A peer that has not answered a ping by the next tick is terminated. */
  heartbeatMs?: number;
  /** A peer whose unsent backlog passes this is terminated: one stalled reader must not grow our memory. */
  maxBufferedBytes?: number;
  /** How long to wait before trying a failed save again. */
  saveRetryMs?: number;
};

export function startSyncServer({ port, secrets, limits, store, heartbeatMs = 15_000, maxBufferedBytes = 1024 * 1024, saveRetryMs = 5000 }: Options): Promise<RunningSyncServer> {
  // A room is stored as a PROMISE so that two peers arriving together share one load, and therefore
  // one room: two rooms for one document would mean two orderings (SPEC §2.1). The promise carries
  // the REASON when a document cannot be opened, so every peer waiting on it is told the same thing.
  type Opened = { room: Room; orgId: string } | { closeCode: number };
  const rooms = new Map<string, Promise<Opened>>();
  const saves = new Set<Promise<void>>();
  const peerCounts = new Map<string, () => number>(); // answered by the ROOM: who has joined, not which sockets exist
  let closing = false;

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
    const verified =
      documentId !== undefined && protocol === PROTOCOL && token !== undefined
        ? verifySessionToken({ token, secrets, documentId, leewaySeconds: TOKEN_LEEWAY_SECONDS })
        : undefined;
    if (documentId === undefined || !verified?.ok) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void serve(ws, documentId, verified.claims);
    });
  });

  /** Loads the document and opens its room, or says why it cannot be opened. Never rejects. */
  async function open(documentId: string, orgId: string): Promise<Opened> {
    const roomLimits = limits ?? {};
    if (!store) return { room: createRoom({ doc: emptyDoc(), manifest, limits: roomLimits }), orgId };
    let stored;
    try {
      stored = await store.load(orgId, documentId);
    } catch {
      return { closeCode: CLOSE.unavailable }; // the database is down: "try again", NOT "your document is broken"
    }
    if (!stored) return { closeCode: CLOSE.documentNotFound };
    const doc = stored.doc ?? emptyDoc();
    // The contract checked each node's shape. Whether they form a TREE is checkDoc's job, and a room
    // must never open on top of a corrupt document: every later op would build on the damage.
    if (checkDoc(doc).length > 0) return { closeCode: CLOSE.documentCorrupt };
    return { room: createRoom({ doc, seq: stored.seq, manifest, limits: roomLimits }), orgId };
  }

  async function serve(ws: WebSocket, documentId: string, claims: { userId: string; orgId: string; expiresAt: number; actor: { kind: "user" | "agent" | "git"; runId?: string } }): Promise<void> {
    // Listeners first: between the upgrade and the end of the load, this socket can already fail.
    // Without an 'error' listener a protocol error on ONE socket (an oversized frame, for one) would be
    // an uncaught exception and take the whole process down (learning-tests/ws).
    ws.on("error", () => undefined);
    // The socket is OPEN for the client from the moment of the upgrade, but the document is still
    // loading. A frame that arrives in between must wait, not vanish: with no 'message' listener yet
    // it would be dropped silently (this lost an op in about one run out of six before it was fixed).
    const early: RawData[] = [];
    let onFrame = (data: RawData): void => void early.push(data);
    ws.on("message", (data) => { onFrame(data); });

    let pending = rooms.get(documentId);
    if (!pending) {
      pending = open(documentId, claims.orgId);
      rooms.set(documentId, pending);
    }
    const opening = pending;
    const opened = await opening;
    if ("closeCode" in opened) {
      if (rooms.get(documentId) === opening) rooms.delete(documentId); // so that a later peer tries again
      ws.close(opened.closeCode, "cannot_open_document");
      return;
    }
    const { room } = opened;
    peerCounts.set(documentId, () => room.peerCount);
    if (ws.readyState !== ws.OPEN) {
      // It went away while the document was loading. It never joined, so no 'close' handler below will
      // ever run for it: if nobody else is here, this is the moment to let the room go.
      if (room.peerCount === 0) closeRoom(documentId, opened.orgId, room, opening);
      return;
    }

    const peer: Peer = {
      // WHO this is comes from the verified token and from nothing else (SPEC §2.3).
      actor: { kind: claims.actor.kind, id: claims.userId, ...(claims.actor.runId === undefined ? {} : { runId: claims.actor.runId }) },
      session: { userId: claims.userId, orgId: claims.orgId, expiresAt: claims.expiresAt },
      send: (message) => {
        if (ws.readyState !== ws.OPEN) return;
        // send() never throws and never blocks: what cannot be written yet is queued IN OUR MEMORY.
        // A peer that stops reading would grow that queue without end, so past the limit it goes.
        if (ws.bufferedAmount > maxBufferedBytes) ws.terminate();
        else ws.send(JSON.stringify(message));
      },
    };

    // Heartbeat: a killed peer is noticed at once (TCP says so); a FROZEN one, or one behind a dead
    // NAT, says nothing at all. Ping, and if the last ping was never answered, it is gone.
    let answered = true;
    ws.on("pong", () => { answered = true; });
    const heartbeat = setInterval(() => {
      if (!answered) {
        ws.terminate();
        return;
      }
      answered = false;
      ws.ping();
    }, heartbeatMs);

    ws.on("close", () => {
      clearInterval(heartbeat);
      room.leave(peer);
      if (room.peerCount === 0 && !closing) closeRoom(documentId, opened.orgId, room, opening);
    });
    onFrame = (data) => {
      let parsed;
      try {
        parsed = ClientMessage.safeParse(JSON.parse(frameText(data)));
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        ws.close(CLOSE.invalidMessage, "invalid_message");
        return;
      }
      void room.submit(peer, parsed.data);
    };
    room.join(peer); // welcome first...
    for (const data of early.splice(0)) onFrame(data); // ...then whatever arrived while the document was loading
  }

  /** Writes the room's document. Waits for ops still in the queue first, so the save is never behind the room. */
  async function save(documentId: string, orgId: string, room: Room): Promise<boolean> {
    try {
      await room.settled();
      await store?.save(orgId, documentId, room.doc, room.seq);
      return true;
    } catch (err) {
      process.stderr.write(`${JSON.stringify({ level: "error", source: "sync", documentId, message: `save failed: ${err instanceof Error ? err.message : "unknown"}` })}\n`);
      return false;
    }
  }

  /**
   * The last peer left: save, then forget the room. A failed save is RETRIED for as long as the room
   * stays empty, because its memory is then the only copy of those edits.
   * ponytail (F8's stated limit): there is no periodic save, so a crash (kill -9) loses every edit
   * since the room opened. Epic 6 replaces this with a journal written before each broadcast.
   */
  function closeRoom(documentId: string, orgId: string, room: Room, opening: Promise<Opened>): void {
    const work = (async () => {
      // peerCount is read through a function: someone may join WHILE a save is awaited, which the
      // type checker cannot know, so it would call the second check "always true".
      const empty = (): boolean => room.peerCount === 0 && rooms.get(documentId) === opening;
      while (empty()) {
        if (await save(documentId, orgId, room)) {
          if (empty()) {
            rooms.delete(documentId);
            peerCounts.delete(documentId);
          }
          return;
        }
        if (closing) return;
        await new Promise((resolve) => setTimeout(resolve, saveRetryMs));
      }
    })();
    saves.add(work);
    void work.finally(() => saves.delete(work));
  }

  return new Promise((resolve) => {
    http.listen(port, () => {
      const address = http.address() as AddressInfo;
      const idle = async (): Promise<void> => {
        while (saves.size > 0) await Promise.all(saves);
      };
      resolve({
        url: `ws://localhost:${String(address.port)}`,
        idle,
        roomCount: () => rooms.size,
        peerCount: (documentId) => peerCounts.get(documentId)?.() ?? 0,
        close: async () => {
          closing = true;
          // FIRST save every open room, while its peers are still connected. Terminating the sockets
          // first looked right and lost everything: their 'close' handlers, which start the saves, only
          // run on a later tick, so "no saves pending" was true and the database pool was closed.
          const open = await Promise.all([...rooms.entries()].map(async ([documentId, opening]) => ({ documentId, opened: await opening })));
          await Promise.all(open.flatMap(({ documentId, opened }) => ("room" in opened ? [save(documentId, opened.orgId, opened.room)] : [])));
          for (const client of wss.clients) client.terminate();
          wss.close();
          await new Promise<void>((done) => {
            http.close(() => { done(); });
            http.closeAllConnections();
          });
          await idle();
        },
      });
    });
  });
}
