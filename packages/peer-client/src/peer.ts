import { ServerMessage, type ClientMessage, type ClientOp, type Doc, type Manifest, type Op } from "@noon/contracts";
import { createReplica, type LocalResult, type Rejection } from "./replica.ts";

/** connecting: opening, or waiting for the welcome. live: edits flow. offline: will retry. closed: will not. */
export type PeerStatus = "connecting" | "live" | "offline" | "closed";

type Options = {
  manifest: Manifest;
  /**
   * Asked before EVERY connection: a session token lives for minutes, a tab for days. Reject = "try
   * again later" (the network is down); resolve null = "give up" (signed out, no access any more).
   */
  session: () => Promise<{ wsUrl: string; token: string } | null>;
  onChange?: () => void;
  onRejected?: (rejection: Rejection) => void;
  onStatus?: (status: PeerStatus) => void;
  /** Node 24 and every browser have the same WebSocket built in, so one client serves both. Tests pass a saboteur. */
  WebSocketImpl?: typeof WebSocket;
  retryMs?: { min: number; max: number };
  /** Something is pending and the server has said NOTHING for this long: the connection is dead even if it looks open. */
  ackTimeoutMs?: number;
};

// Close codes that reconnecting cannot cure (apps/sync/src/server.ts): a message the server could
// not accept (our bug), no such document, a corrupt document, a frame over the size limit.
const FATAL_CLOSE_CODES = new Set([4400, 4404, 4500, 1009]);

/**
 * The ONE write path to a document (SPEC keystone 2): a browser tab, the AI worker and the git peer
 * all edit through this. The thinking is in replica.ts; this file is only the wire: connect, wait
 * for the welcome, send, reconnect.
 */
export function connectPeer({ manifest, session, onChange, onRejected, onStatus, WebSocketImpl = WebSocket, retryMs = { min: 250, max: 10_000 }, ackTimeoutMs = 10_000 }: Options) {
  const replica = createReplica({ manifest });
  let status: PeerStatus = "closed"; // until open() below, a line from now; this way the first onStatus is "connecting"
  let closedBecause: string | undefined;
  let socket: WebSocket | undefined;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHeard = 0;

  const setStatus = (next: PeerStatus): void => {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  };

  function send(ops: ClientOp[]): void {
    if (status !== "live") return; // still pending in the replica; the next welcome sends them
    for (const op of ops) socket?.send(JSON.stringify({ type: "op", ...op } satisfies ClientMessage));
  }

  function finish(reason: string): void {
    closedBecause = reason;
    clearTimeout(retryTimer);
    clearInterval(watchdog);
    const old = socket;
    socket = undefined; // its close event must not start a reconnect
    old?.close();
    setStatus("closed");
  }

  function retryLater(): void {
    if (status === "closed") return;
    setStatus("offline");
    // Exponential, capped, with jitter: after a server restart a thousand tabs must not all return in the same millisecond.
    const delay = Math.min(retryMs.max, retryMs.min * 2 ** attempt++) * (0.5 + Math.random() / 2);
    retryTimer = setTimeout(() => void open(), delay);
  }

  /** Drop this connection and come back through a fresh welcome. Everything pending is resent then. */
  function resync(): void {
    const old = socket;
    socket = undefined;
    old?.close();
    retryLater();
  }

  function onMessage(from: WebSocket, data: unknown): void {
    if (from !== socket) return; // a frame from a connection we have already given up on
    let parsed;
    try {
      parsed = ServerMessage.safeParse(JSON.parse(String(data)));
    } catch {
      parsed = undefined;
    }
    // The server speaks a protocol this client does not: retrying would loop. The page must be reloaded.
    if (!parsed?.success) { finish("protocol"); return; }
    lastHeard = Date.now();
    const effects = replica.receive(parsed.data);
    if (parsed.data.type === "welcome") {
      attempt = 0;
      setStatus("live");
    }
    for (const rejection of effects.rejected) onRejected?.(rejection);
    onChange?.();
    if (effects.resync) resync();
    else send(effects.send);
  }

  async function open(): Promise<void> {
    setStatus("connecting");
    let target;
    try {
      target = await session();
    } catch {
      retryLater();
      return;
    }
    if (status !== "connecting") return; // close() was called while we were asking
    if (!target) { finish("no_session"); return; }

    // The token rides in Sec-WebSocket-Protocol: the only header a browser lets a WebSocket set.
    const mine = new WebSocketImpl(target.wsUrl, ["noon.v1", target.token]);
    socket = mine;
    lastHeard = Date.now();
    mine.addEventListener("message", (event: MessageEvent) => { onMessage(mine, event.data); });
    // No "error" listener: an error is always followed by "close", and close carries the code.
    mine.addEventListener("close", (event: CloseEvent) => {
      if (mine !== socket) return; // we closed it ourselves
      socket = undefined;
      if (FATAL_CLOSE_CODES.has(event.code)) finish(String(event.code));
      else retryLater();
    });
  }

  // ponytail: one coarse timer instead of a deadline per op. A browser cannot see the server's pings,
  // so silence while something is pending is the only sign of a half-open connection.
  const watchdog = setInterval(() => {
    if (status === "live" && replica.pending.length > 0 && Date.now() - lastHeard > ackTimeoutMs) resync();
  }, ackTimeoutMs / 2);
  (watchdog as { unref?: () => void }).unref?.(); // in Node, a timer must not keep a finished script alive

  void open();

  return {
    /** What the user sees: confirmed edits plus our own unconfirmed ones. Read only. */
    get doc(): Doc { return replica.doc; },
    get status(): PeerStatus { return status; },
    /** Why the peer ended for good: a close code, "protocol", "no_session" or "closed_by_caller". */
    get closedBecause(): string | undefined { return closedBecause; },
    get pendingCount(): number { return replica.pending.length; },

    /** Make an edit. Shown at once; sent now, or after the next welcome if we are not live. */
    submit(op: Op): LocalResult {
      const result = replica.local(op);
      if (result.ok) {
        if (replica.pending.length === 1) lastHeard = Date.now(); // the silence clock starts with the first thing we wait for
        send([result.send]);
        onChange?.();
      }
      return result;
    },

    close(): void { finish("closed_by_caller"); },
  };
}

