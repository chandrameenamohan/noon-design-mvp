import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { ClientMessage, type Doc, type HealthResponse, type Role, type SequencedOp } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import { keepLease, takeLease, type Holder, type Leases } from "@noon/lease";
import { manifest } from "@noon/design-system";
import { applyOpInto, checkDoc, emptyDoc } from "@noon/doc-model";
import { verifySessionToken } from "@noon/session-token";
import { frameText } from "./raw.ts";
import { watchFence } from "./fence.ts";
import { reportSlow } from "./slow.ts";
import { createRoom, type Peer, type RateLimit, type Room, type RoomLimits } from "./room.ts";
import { decodeSnapshot, snapshotter, type SnapshotCadence, type SnapshotStore } from "./snapshots.ts";

export type RunningSyncServer = {
  url: string;
  close(): Promise<void>;
  /** Resolves when no last-leave snapshot is in flight. */
  idle(): Promise<void>;
  peerCount(documentId: string): number;
  roomCount(): number;
  /**
   * E8.2 (F24): an owner changed this user's role in this org, or a share of one of its documents (E8.3), or "all":
   * changes may have been missed. Every live session it concerns reads its role again and keeps to it from its next
   * op; one with no access left is closed (4404). Resolves once they have. Never rejects.
   */
  recheck(change: { orgId: string; userId: string } | "all"): Promise<void>;
};

const PROTOCOL = "noon.v1";
export const MAX_FRAME_BYTES = 64 * 1024; // an op is small; the contract caps props, this caps the frame BEFORE it is parsed
// A journal call slower than this is logged: the e2e bound on a whole edit, browser to browser, is 200 ms.
const SLOW_JOURNAL_MS = 250;
const TOKEN_LEEWAY_SECONDS = 5; // the api signs, this process verifies: two clocks never agree exactly
const DOCUMENT_PATH = /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// 4000-4999 are ours to define. They mirror the HTTP status a REST call would have had.
// roomElsewhere (a 409, "conflict"): another sync node owns this document's room. Not fatal to a peer: it
// asks /session again, which answers with the owner's address.
const CLOSE = { invalidMessage: 4400, documentNotFound: 4404, roomElsewhere: 4409, tooManyRequests: 4429, documentCorrupt: 4500, unavailable: 4503 } as const;

type Options = {
  port: number;
  secrets: readonly string[];
  limits?: Partial<RoomLimits>;
  /** Each peer's op budget (room.ts). */
  rate?: Partial<RateLimit>;
  /** Where documents and their journals are kept. Without one, rooms start empty and nothing is kept. */
  store?: DocumentStore;
  /** Where rooms write their snapshots (MinIO, E6.2). Without one, a room never snapshots and opening replays the whole journal. */
  snapshots?: SnapshotStore;
  /** When a room snapshots: every `everyOps` ops, every `everyMs` while peers are connected, and always on last leave. */
  cadence?: Partial<SnapshotCadence>;
  /** A peer that has not answered a ping by the next tick is terminated. */
  heartbeatMs?: number;
  /** A peer whose unsent backlog passes this is terminated: one stalled reader must not grow our memory. */
  maxBufferedBytes?: number;
  /** A journal call that has not answered by then counts as failed: a paused or partitioned database hangs rather than refuses. */
  journalTimeoutMs?: number;
  /** How often a read-only room asks the journal whether it can write again (E6.1b). */
  recoverMs?: number;
  /**
   * Room ownership across sync nodes (F20): a room opens here only while this node holds the document's lease
   * in Redis. Without it this process opens every room it is asked for, which is right for exactly one node.
   */
  lease?: { leases: Leases; nodeId: string };
  /**
   * E8.2 (F24): a user's role on the document, if it is that org's and they are a member or it is shared with them
   * (db.roleIn, E8.3). Asked at the upgrade, when a peer joins and on every `recheck`: a viewer's ops are refused, and
   * someone with no access is refused a socket (401) or closed out (4404). The token says only who someone is, never
   * what they may do. Without it every peer may edit (tests without a database).
   */
  roles?: (orgId: string, documentId: string, userId: string) => Promise<Role | undefined>;
  /**
   * E8.3 (F25): every live session's role is read again this often, whatever was announced: the backstop for an
   * announcement the api could not publish (it tries once), so a revoked share cannot stay open for good.
   */
  sweepMs?: number;
};

export function startSyncServer({ port, secrets, limits, rate, store, snapshots, cadence: cadenceOverrides, heartbeatMs = 15_000, maxBufferedBytes = 1024 * 1024, journalTimeoutMs = 5000, recoverMs = 1000, lease, roles, sweepMs = 30_000 }: Options): Promise<RunningSyncServer> {
  const cadence: SnapshotCadence = { everyOps: 500, everyMs: 30_000, ...cadenceOverrides };
  // A room is stored as a PROMISE so that two peers arriving together share one load, and therefore
  // one room: two rooms for one document would mean two orderings (SPEC §2.1). The promise carries
  // the REASON when a document cannot be opened, so every peer waiting on it is told the same thing.
  type Loaded = { room: Room; orgId: string; snapshot?: ReturnType<typeof snapshotter> };
  // With leases, an open room also knows its sockets (to send them elsewhere when the lease is lost), whether
  // it lost the lease, and how to let the lease go.
  type Owned = Loaded & { sockets: Set<WebSocket>; lost: boolean; release: () => Promise<void> };
  type Opened = Owned | { closeCode: number };
  const rooms = new Map<string, Promise<Opened>>();
  const leaving = new Set<Promise<void>>();
  const peerCounts = new Map<string, () => number>(); // answered by the ROOM: who has joined, not which sockets exist
  let closing = false;
  // Every socket past the upgrade, from BEFORE its role is first read: a change published while that read is in
  // flight still finds it. `asked`/`applied` number the reads, so an older answer never replaces a newer one.
  type Connected = { peer: Peer; ws: WebSocket; documentId: string; asked: number; applied: number };
  const connected = new Set<Connected>();
  // "Alive" into Redis every tenth of a ttl (E7.2): /session stops sending peers to a node that went quiet,
  // and a node knows which leases can only expire. A failed beat is not logged: Redis being away already is.
  const beat = (): void => { if (lease && !closing) void lease.leases.beat(lease.nodeId).catch(() => undefined); };
  const beating = lease ? setInterval(beat, lease.leases.ttlMs / 10) : undefined;
  beating?.unref();
  beat();
  // ponytail: one indexed read per live session per sweep; ceiling: a few thousand sessions a node (a sweep never
  // overlaps the last one); upgrade: one query for all of a node's (org, document, user) triples.
  let sweeping = false;
  const sweeper = roles ? setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void recheck("all").finally(() => { sweeping = false; });
  }, sweepMs) : undefined;
  sweeper?.unref();

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
    // The http server let go of the socket's errors when it handed it to us. FIRST, before anything can refuse it:
    // a peer answered 401 that then resets the connection had no listener, and one such reset was an uncaught
    // exception, the end of the process and of every room on the node, with no token needed (noon-cs6.3).
    socket.on("error", () => undefined);
    const documentId = DOCUMENT_PATH.exec(new URL(req.url ?? "/", "http://sync").pathname)?.[1]?.toLowerCase();
    // The token is the second entry of Sec-WebSocket-Protocol: the one header a browser lets a page
    // set on a WebSocket. A query string would put the token in proxy logs and Referer headers.
    const [protocol, token] = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((part) => part.trim());
    const verified =
      documentId !== undefined && protocol === PROTOCOL && token !== undefined
        ? verifySessionToken({ token, secrets, documentId, leewaySeconds: TOKEN_LEEWAY_SECONDS })
        : undefined;
    const refuse = (): void => void socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    if (documentId === undefined || !verified?.ok) {
      refuse();
      return;
    }
    void admits(verified.claims, documentId).then((yes) => {
      if (closing) socket.destroy(); // shutting down while we asked: the peer reconnects elsewhere
      else if (!yes) refuse();
      else wss.handleUpgrade(req, socket, head, (ws) => { void serve(ws, documentId, verified.claims); });
    });
  });

  /**
   * E8.3 (F25): may the token's holder still open the document? A token lives 60 s: one minted before a revoke (or
   * before a demotion out of the org) must not open a socket, so a valid signature alone is not enough. Asked BEFORE
   * the upgrade, so a revoked peer's reconnect is a plain 401, like any other token that is no good. Postgres not
   * answering is not a no: serve() asks again, and says "try again" (4503). A revoke landing after this read and
   * before serve() registers the socket is still caught: serve() reads once more, after registering it.
   * ponytail: two reads per connect; ceiling: none that matters (primary-key probes); upgrade: carry this answer into
   * serve() with a "changed meanwhile" flag.
   */
  async function admits(claims: { userId: string; orgId: string; actor: { kind: "user" | "agent" | "git" } }, documentId: string): Promise<boolean> {
    if (!roles || claims.actor.kind === "git") return true;
    try {
      return (await roles(claims.orgId, documentId, claims.userId)) !== undefined;
    } catch {
      return true;
    }
  }

  /**
   * Takes the document's lease (when there are several nodes), then loads the room. Never rejects.
   * `forget` drops this room from `rooms` if it is still the current one there.
   */
  async function open(documentId: string, orgId: string, forget: () => void): Promise<Opened> {
    const owned = (loaded: Loaded, release: () => Promise<void>): Owned => ({ ...loaded, sockets: new Set(), lost: false, release });
    if (!lease) {
      const loaded = await load(documentId, orgId);
      return "closeCode" in loaded ? loaded : owned(loaded, () => Promise.resolve());
    }
    const { leases, nodeId } = lease;
    // The largest token that ever claimed the document (E7.3): ours must be above it, even after a Redis flush.
    let floor = 0;
    if (store) {
      let fence;
      try {
        fence = await store.fence(orgId, documentId);
      } catch {
        return { closeCode: CLOSE.unavailable };
      }
      if (fence === undefined) return { closeCode: CLOSE.documentNotFound };
      floor = fence;
    }
    let holder: Holder;
    let acquiredAt: number; // BEFORE the winning send: our deadline must never outlast Redis's (lease.ts)
    try {
      // Another live node owns the room: its peers are sent back to /session, which names the owner. A dead
      // one's lease (or our own previous run's) is waited out here, up to one ttl, and then the room is ours (F21).
      const taken = await takeLease({
        acquire: () => leases.acquire(documentId, nodeId, floor), alive: async (id) => (await leases.alive([id])).has(id),
        nodeId, ttlMs: leases.ttlMs, now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
      });
      if (!taken) return { closeCode: CLOSE.roomElsewhere };
      ({ holder, acquiredAt } = taken);
    } catch (err) {
      // Redis cannot say who owns it: opening anyway could make a second room. "Try again" instead.
      log(documentId, `lease not taken: ${err instanceof Error ? err.message : "unknown"}`);
      return { closeCode: CLOSE.unavailable };
    }
    // Renewal starts NOW, not after the load: a long replay must not let the lease lapse unnoticed.
    const opened: { room?: Owned } = {}; // filled once loaded
    // The lease ran out (our clock) or the journal fenced us (a newer owner claimed the document): stop writing,
    // send the peers to the new owner.
    const drop = (why: string): void => {
      clearInterval(renewing);
      const { room } = opened;
      if (!room || room.lost) return; // still loading: the check after load() below refuses it
      log(documentId, `lease ${String(holder.token)} ${why}: its peers are sent to the new owner`);
      room.lost = true;
      room.snapshot?.stop();
      forget(); // the next peer asks Redis again
      for (const socket of room.sockets) socket.close(CLOSE.roomElsewhere, "room_elsewhere");
    };
    const keeper = keepLease({
      renew: () => leases.renew(documentId, holder), ttlMs: leases.ttlMs, now: () => performance.now(), acquiredAt,
      onLost: () => { drop("lost"); },
    });
    const renewing = setInterval(() => void keeper.tick(), leases.ttlMs / 3);
    renewing.unref();
    const release = async (): Promise<void> => {
      clearInterval(renewing);
      if (!keeper.held) return;
      await leases.release(documentId, holder).catch((err: unknown) => {
        log(documentId, `lease not released, it expires by itself: ${err instanceof Error ? err.message : "unknown"}`);
      });
    };
    // The fence (F22), BEFORE the journal is read: from here on only this opening's appends land, and every row a
    // previous owner added before this moment is in what load() replays. A lost claim: a newer lease exists.
    const claim = randomUUID();
    let claimed = true;
    if (store) {
      try {
        claimed = await store.claim(orgId, documentId, holder.token, claim);
      } catch {
        await release();
        return { closeCode: CLOSE.unavailable };
      }
    }
    const loaded = claimed ? await load(documentId, orgId, { claim, onFenced: () => { drop("fenced by a newer owner's claim"); } }) : { closeCode: CLOSE.roomElsewhere };
    if ("closeCode" in loaded || !keeper.held) {
      await release();
      if (!("closeCode" in loaded)) loaded.snapshot?.stop();
      return "closeCode" in loaded ? loaded : { closeCode: CLOSE.roomElsewhere };
    }
    opened.room = owned(loaded, release);
    return opened.room;
  }

  /**
   * Loads the document and its room, or says why it cannot be opened. Never rejects. `fence`: this opening's claim,
   * which every append carries (E7.3); without leases there is none, and only a never-claimed document is written.
   */
  async function load(documentId: string, orgId: string, fence?: { claim: string; onFenced: () => void }): Promise<Loaded | { closeCode: number }> {
    const roomLimits = limits ?? {};
    if (!store) return { room: createRoom({ doc: emptyDoc(), manifest, limits: roomLimits, ...(rate ? { rate } : {}) }), orgId };
    let stored;
    try {
      stored = await store.load(orgId, documentId);
    } catch {
      return { closeCode: CLOSE.unavailable }; // the database is down: "try again", NOT "your document is broken"
    }
    if (!stored) return { closeCode: CLOSE.documentNotFound };
    // The newest snapshot, or what F8's idle save wrote before E6.2 if that is newer (a document not
    // snapshotted since). Then only the journal rows after it (F19).
    let doc: Doc;
    let seq: number;
    if (stored.snapshotSeq > stored.seq) {
      if (!snapshots) return { closeCode: CLOSE.unavailable }; // snapshotted, and this process was started without MinIO
      let bytes;
      try {
        bytes = await snapshots.get(orgId, documentId, stored.snapshotSeq);
      } catch {
        return { closeCode: CLOSE.unavailable }; // MinIO is down: "try again"
      }
      // Postgres names it only after it was stored, so a missing or unreadable one is damage, not an outage.
      const decoded = bytes && decodeSnapshot(bytes);
      if (!decoded) {
        log(documentId, `snapshot ${String(stored.snapshotSeq)} is ${bytes ? "not a well-formed document" : "missing"}`);
        return { closeCode: CLOSE.documentCorrupt };
      }
      doc = decoded;
      seq = stored.snapshotSeq;
    } else {
      doc = stored.doc ?? emptyDoc();
      seq = stored.seq;
    }
    // The contract checked each node's shape. Whether they form a TREE is checkDoc's job, and a room
    // must never open on top of a corrupt document: every later op would build on the damage.
    if (checkDoc(doc).length > 0) return { closeCode: CLOSE.documentCorrupt };
    try {
      for (const row of await store.since(orgId, documentId, seq)) {
        applyOpInto(doc, row.op);
        seq = row.seq;
      }
    } catch {
      return { closeCode: CLOSE.unavailable };
    }
    // A timed-out append may still land later: the room treats it as failed, and recover() replays it if it did.
    // A fenced one never lands: the room is dropped, not healed (a newer owner is writing).
    let fenced = false;
    // An edit reaches the other browsers only after these answer: a slow one is logged, with which it was.
    const timed = reportSlow(SLOW_JOURNAL_MS, (what, ms) => { log(documentId, `journal ${what} took ${String(ms)} ms`, "warn"); });
    const journal = {
      append: watchFence((op: SequencedOp) => timed("append", bounded(store.append(orgId, documentId, op, fence?.claim))), () => {
        fenced = true;
        fence?.onFenced();
      }),
      find: (actorId: string, opId: string) => timed("find", bounded(store.find(orgId, documentId, actorId, opId))),
      everAdded: (nodeId: string) => timed("everAdded", bounded(store.everAdded(orgId, documentId, nodeId))),
      since: (after: number) => timed("since", bounded(store.since(orgId, documentId, after))),
    };
    const snapshotFrom = Math.max(stored.snapshotSeq, stored.seq);
    let snapshot: ReturnType<typeof snapshotter> | undefined;
    const room: Room = createRoom({
      doc, seq, manifest, limits: roomLimits, journal, ...(rate ? { rate } : {}),
      onReadOnly: () => { if (!fenced) heal(room); },
      onAccepted: (accepted) => { snapshot?.accepted(accepted); },
    });
    if (snapshots) {
      const to = snapshots;
      // MinIO first, THEN Postgres: the pointer never names an object that is not there. Either failing
      // loses nothing (the journal holds every op), it only leaves more rows for the next open to replay.
      snapshot = snapshotter({
        room, from: snapshotFrom, cadence,
        write: async (at, body) => {
          try {
            await to.put(orgId, documentId, at, body);
            await store.snapshotted(orgId, documentId, at);
          } catch (err) {
            log(documentId, `snapshot ${String(at)} failed: ${err instanceof Error ? err.message : "unknown"}`);
            throw err;
          }
        },
      });
    }
    return { room, orgId, ...(snapshot ? { snapshot } : {}) };
  }

  /**
   * Reads what this peer may do, and applies it. False: it is no member (any more), and was closed out. Rejects when
   * Postgres did not answer. The git peer is the service itself (its id names a commit event, not a person); an AI
   * run is its creator, so it can do what they can.
   */
  async function applyRole(entry: Connected): Promise<boolean> {
    const { peer, ws, documentId } = entry;
    if (!roles || peer.actor.kind === "git") {
      peer.mayEdit = true;
      return true;
    }
    const asked = ++entry.asked;
    const role = await roles(peer.session.orgId, documentId, peer.session.userId);
    if (asked < entry.applied) return ws.readyState === ws.OPEN; // a newer read already decided
    entry.applied = asked;
    if (role === undefined) {
      // The same answer a stranger's token gets: the document is not there for them.
      ws.close(CLOSE.documentNotFound, "cannot_open_document");
      return false;
    }
    peer.mayEdit = role !== "viewer";
    return true;
  }

  async function recheck(change: { orgId: string; userId: string } | "all"): Promise<void> {
    const due = [...connected].filter(({ peer }) => change === "all" || (peer.session.orgId === change.orgId && peer.session.userId === change.userId));
    await Promise.all(due.map(async (entry) => {
      // Until Postgres answers or the socket goes: a demotion must not be lost to one failed read.
      while (!closing && connected.has(entry)) {
        try {
          await applyRole(entry);
          return;
        } catch (err) {
          log(entry.documentId, `role not read again, retrying: ${err instanceof Error ? err.message : "unknown"}`);
          await new Promise((resolve) => setTimeout(resolve, recoverMs).unref());
        }
      }
    }));
  }

  function log(documentId: string, message: string, level: "error" | "warn" = "error"): void {
    process.stderr.write(`${JSON.stringify({ level, source: "sync", documentId, message })}\n`);
  }

  function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("journal timed out")); }, journalTimeoutMs); });
    return Promise.race([work, late]).finally(() => { clearTimeout(timer); });
  }

  /**
   * The room went read-only (E6.1b): ask it to recover every `recoverMs` until the journal answers.
   * ponytail: a read-only room that was dropped meanwhile keeps asking too, one cheap read a tick, until
   * the database is back; ceiling: one timer per such room, for as long as the outage lasts.
   */
  function heal(room: Room): void {
    void (async () => {
      while (room.readOnly && !closing) {
        await new Promise((resolve) => setTimeout(resolve, recoverMs).unref());
        await room.recover();
      }
    })();
  }

  async function serve(ws: WebSocket, documentId: string, claims: { userId: string; orgId: string; expiresAt: number; actor: { kind: "user" | "agent" | "git"; runId?: string }; name?: string }): Promise<void> {
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
      sendText: (text) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount <= maxBufferedBytes) ws.send(text); else if (ws.readyState === ws.OPEN) ws.terminate(); },
      ...(claims.name === undefined ? {} : { name: claims.name }),
      kick: () => { ws.close(CLOSE.tooManyRequests, "rate_limited"); },
      mayEdit: false, // until its role is read
    };

    // E8.2 (F24): who may be here and edit is Postgres's answer, asked BEFORE any room is opened for them.
    const entry: Connected = { peer, ws, documentId, asked: 0, applied: 0 };
    connected.add(entry);
    ws.on("close", () => { connected.delete(entry); });
    try {
      if (!(await applyRole(entry))) return;
    } catch {
      ws.close(CLOSE.unavailable, "unavailable"); // "try again", as when the document cannot be loaded
      return;
    }

    let pending = rooms.get(documentId);
    if (!pending) {
      const fresh: Promise<Opened> = open(documentId, claims.orgId, () => {
        if (rooms.get(documentId) !== fresh) return;
        rooms.delete(documentId);
        peerCounts.delete(documentId);
      });
      pending = fresh;
      rooms.set(documentId, pending);
    }
    const opening = pending;
    const opened = await opening;
    if ("closeCode" in opened) {
      if (rooms.get(documentId) === opening) rooms.delete(documentId); // so that a later peer tries again
      ws.close(opened.closeCode, "cannot_open_document");
      return;
    }
    // One room = one org: the org of whoever opened it. Two processes mint tokens now (the api and the
    // AI worker); a token for this document under ANOTHER org is a stranger, whoever signed it.
    if (claims.orgId !== opened.orgId) {
      ws.close(CLOSE.documentNotFound, "cannot_open_document");
      return;
    }
    if (opened.lost) {
      ws.close(CLOSE.roomElsewhere, "room_elsewhere"); // it lost its lease while this peer was on its way in
      return;
    }
    const { room } = opened;
    peerCounts.set(documentId, () => room.peerCount);
    if (ws.readyState !== ws.OPEN) {
      // It went away while the document was loading. It never joined, so no 'close' handler below will
      // ever run for it: if nobody else is here, this is the moment to let the room go.
      if (room.peerCount === 0) closeRoom(documentId, opened, opening);
      return;
    }

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

    opened.sockets.add(ws);
    ws.on("close", () => {
      clearInterval(heartbeat);
      opened.sockets.delete(ws);
      room.leave(peer);
      if (room.peerCount === 0 && !closing) closeRoom(documentId, opened, opening);
    });
    onFrame = (data) => {
      if (opened.lost) return; // being sent elsewhere: take nothing more (an op already in the queue meets the fence)
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
      if (parsed.data.type === "presence") room.presence(peer, parsed.data);
      else void room.submit(peer, parsed.data);
    };
    room.join(peer); // welcome first...
    for (const data of early.splice(0)) onFrame(data); // ...then whatever arrived while the document was loading
  }

  /** The room's last snapshot, once the ops still in its queue are handled. False: not stored (logged). */
  async function snapshotNow(opened: Owned): Promise<boolean> {
    // A room that lost its lease writes nothing more: the new owner is the only writer (the journal is fenced).
    if (opened.lost) return false;
    await opened.room.settled();
    return (await opened.snapshot?.take()) ?? true;
  }

  /**
   * The last peer left: snapshot, then forget the room. A failed snapshot is NOT retried: the journal holds
   * every op this room accepted (E6.1a), so the next open replays what the snapshot would have held.
   * This replaced F8's save, which had to retry for ever because the room's memory was the only copy.
   */
  function closeRoom(documentId: string, opened: Owned, opening: Promise<Opened>): void {
    const work = (async () => {
      await snapshotNow(opened);
      // Someone may have joined WHILE the snapshot was written: then the room stays.
      if (opened.room.peerCount === 0 && (opened.lost || rooms.get(documentId) === opening)) {
        opened.snapshot?.stop();
        if (rooms.get(documentId) === opening) {
          rooms.delete(documentId);
          peerCounts.delete(documentId);
        }
        await opened.release(); // after the snapshot: the next owner opens from it
      }
    })();
    leaving.add(work);
    void work.finally(() => leaving.delete(work));
  }

  return new Promise((resolve) => {
    http.listen(port, () => {
      const address = http.address() as AddressInfo;
      const idle = async (): Promise<void> => {
        while (leaving.size > 0) await Promise.all(leaving);
      };
      resolve({
        url: `ws://localhost:${String(address.port)}`,
        idle,
        roomCount: () => rooms.size,
        recheck,
        peerCount: (documentId) => peerCounts.get(documentId)?.() ?? 0,
        close: async () => {
          closing = true;
          clearInterval(beating);
          clearInterval(sweeper);
          // FIRST snapshot every open room, while its peers are still connected. Terminating the sockets
          // first (under F8's save) lost everything: their 'close' handlers only run on a later tick, so
          // "nothing pending" was true and the database pool was closed.
          const open = await Promise.all([...rooms.values()]);
          await Promise.all(open.map(async (opened) => {
            if (!("room" in opened)) return;
            await snapshotNow(opened);
            opened.snapshot?.stop();
            await opened.release(); // another node may take the room at once, not a ttl later
          }));
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
