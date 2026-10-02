import { ServerMessage, type ClientMessage, type Doc, type Presence, type Manifest, type Op, type SequencedOp } from "@noon/contracts";
import { createReplica, type LocalResult, type Outcome, type Rejection } from "./replica.ts";

export type { Outcome, Rejection };

/** What submit() gives back: the replica's own verdict now, and for an accepted op the server's verdict later. `settled` never rejects. */
export type Submitted = { ok: true; opId: string; settled: Promise<Outcome> } | Extract<LocalResult, { ok: false }>;

/** connecting: opening, or waiting for the welcome. live: edits flow. offline: will retry. closed: will not. */
export type PeerStatus = "connecting" | "live" | "offline" | "closed";

export type PeerOptions = {
  manifest: Manifest;
  /**
   * Asked before EVERY connection: a session token lives for minutes, a tab for days. Reject = "try
   * again later" (the network is down); resolve null = "give up" (signed out, no access any more).
   */
  session: () => Promise<{ wsUrl: string; token: string } | null>;
  onChange?: () => void;
  /** An edit of ours that will not happen: refused by the server, or still unsent when the peer ended for good ("connection_closed"). */
  onRejected?: (rejection: Rejection) => void;
  /**
   * Every op the room has ORDERED, ours included, with the actor the room stamped on it, told after it is
   * applied. A window onto who did what (E10.6: the AI's cursor sits on the node its last op touched); not
   * a place to edit from, and nothing here depends on it being listened to.
   */
  onOp?: (message: SequencedOp) => void;
  onStatus?: (status: PeerStatus) => void;
  /** Node 24 and every browser have the same WebSocket built in, so one client serves both. Tests pass a saboteur. */
  WebSocketImpl?: typeof WebSocket;
  retryMs?: { min: number; max: number };
  /** We are waiting (for a welcome, or for an answer to an op) and the server has said NOTHING for this long: the connection is dead even if it looks open. */
  ackTimeoutMs?: number;
  maxPending?: number;
  /** Where each op's id comes from (default: a random UUID). An AI run mints the same ids on every attempt of its job (F28). */
  mintOpId?: (op: Op) => string;
  /** Presence timing: send our own at most every `sendEveryMs`, repeat it every `refreshMs`, forget a peer silent for `forgetAfterMs`. */
  presence?: { sendEveryMs: number; refreshMs: number; forgetAfterMs: number };
};

/** What we show of ourselves: where the pointer is (in the canvas's world coordinates) and what is selected. */
type OwnPresence = Pick<Presence, "cursor" | "selection">;

// Close codes that reconnecting cannot cure (apps/sync/src/server.ts): a message the server could
// not accept (our bug), no such document, a corrupt document, a frame over the size limit.
const FATAL_CLOSE_CODES = new Set([4400, 4404, 4500, 1009]);
const KNOWN_TYPES: ReadonlySet<unknown> = new Set(ServerMessage.options.map((option) => option.shape.type.value));

/**
 * The ONE write path to a document (SPEC keystone 2): a browser tab, the AI worker and the git peer
 * all edit through this. The thinking is in replica.ts; this file is only the wire: connect, wait
 * for the welcome, send, reconnect.
 */
export function connectPeer({ manifest, session, onChange, onRejected, onOp, onStatus, WebSocketImpl = WebSocket, retryMs = { min: 250, max: 10_000 }, ackTimeoutMs = 10_000, maxPending, mintOpId, presence: timing = { sendEveryMs: 50, refreshMs: 2000, forgetAfterMs: 5000 } }: PeerOptions) {
  const replica = createReplica({ manifest, ...(maxPending === undefined ? {} : { maxPending }), ...(mintOpId === undefined ? {} : { mintOpId }) });
  let status: PeerStatus = "closed"; // until open() below, a line from now; this way the first onStatus is "connecting"
  let closedBecause: string | undefined;
  let socket: WebSocket | undefined;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHeard = 0;
  let liveSince = 0;
  // E6.1b: the room cannot make edits durable. What we sent is held, new edits are refused, until it says otherwise.
  let readOnly = false;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  const endPause = (): void => {
    clearTimeout(pauseTimer);
    pauseTimer = undefined;
    lastHeard = Date.now(); // the silence during a pause was ours, not the server's
  };

  // Whoever asked about an op's fate (submit().settled). Only ops still unanswered are in here.
  const waiting = new Map<string, (outcome: Outcome) => void>();
  const settle = (opId: string, outcome: Outcome): void => {
    waiting.get(opId)?.(outcome);
    waiting.delete(opId);
  };

  const setStatus = (next: PeerStatus): void => {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  };

  /** Writes whatever the replica says may go out now. Not live, or told to slow down: it all stays pending. */
  function flush(): void {
    if (status !== "live" || pauseTimer !== undefined || readOnly) return;
    for (const op of replica.takeSendable()) socket?.send(JSON.stringify({ type: "op", ...op } satisfies ClientMessage));
  }

  // --- presence: who else is here. Not part of the document, so not the replica's business. ---
  // Others are kept with the time we last heard of them: a connection that DIES says no goodbye, and
  // the server may not notice for a while, so silence is what removes a peer here (F7: within 5 s).
  let others = new Map<string, { entry: Presence; heardAt: number }>();
  let presenceRevision = 0;
  // Every peerId this client has had. After a reconnect the room may still list our OLD connection
  // (it has not noticed yet that it is dead): that one is us, not someone else in the document.
  const mine = new Set<string>();
  let own: OwnPresence | undefined;
  let ownSentAt = 0;
  let ownTimer: ReturnType<typeof setTimeout> | undefined;

  function changePresence(change: () => void): void {
    change();
    presenceRevision++;
    onChange?.();
  }

  /** Sends our presence now, or as soon as the interval allows; always the LATEST state, never a backlog. */
  function sendOwn(): void {
    clearTimeout(ownTimer);
    ownTimer = undefined;
    if (own === undefined || status === "closed") return;
    const wait = ownSentAt + timing.sendEveryMs - Date.now();
    if (status === "live" && wait <= 0) {
      socket?.send(JSON.stringify({ type: "presence", ...own } satisfies ClientMessage));
      ownSentAt = Date.now();
      ownTimer = setTimeout(sendOwn, timing.refreshMs); // "still here": what keeps us in the others' lists
    } else if (status === "live") ownTimer = setTimeout(sendOwn, wait);
    // not live: the next welcome calls this again
  }

  function finish(reason: string): void {
    closedBecause = reason;
    clearTimeout(retryTimer);
    clearInterval(watchdog);
    clearInterval(sweeper);
    clearTimeout(ownTimer);
    endPause();
    const old = socket;
    socket = undefined; // its close event must not start a reconnect
    old?.close();
    // Whatever is still unsent never will be. Say so, instead of showing edits that no longer exist anywhere.
    for (const rejection of replica.abandon()) {
      settle(rejection.opId, { ok: false, reason: rejection.reason });
      onRejected?.(rejection);
    }
    setStatus("closed");
    onChange?.();
  }

  function retryLater(): void {
    if (status === "closed") return;
    readOnly = false; // it belonged to that room; the next welcome says again
    setStatus("offline");
    // The pause starts over only after a connection that LASTED. Resetting it on every welcome made
    // "welcome, then drop" (a crash-looping server, a failing database) a reconnect every 250 ms, for ever,
    // each one costing the api a session token and the room a copy of the document.
    if (liveSince > 0 && Date.now() - liveSince > retryMs.max) attempt = 0;
    liveSince = 0;
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
    lastHeard = Date.now();
    // What we cannot read, we skip: a binary frame, broken JSON, or a message type added after this
    // client was loaded (every open tab meets one during a deploy). Ending the peer over it would
    // throw away the user's unsent edits.
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const type: unknown = typeof raw === "object" && raw !== null && "type" in raw ? raw.type : undefined;
    if (!KNOWN_TYPES.has(type)) return;
    // A type we DO know, in a shape the contract forbids: nothing this server says can be relied on.
    let parsed = ServerMessage.safeParse(raw);
    // A refusal whose REASON is newer than this client: all we need to know is that the op was not
    // applied. "unavailable" says exactly that (keep it, come back through a fresh welcome).
    // Presence is cosmetic: a frame of it that we cannot read is dropped like an unknown type. Ending
    // the peer over it would throw away the user's unsent edits because of someone's pointer.
    if (!parsed.success && (type === "presence" || type === "presence_left")) return;
    if (!parsed.success && type === "rejected") parsed = ServerMessage.safeParse({ ...(raw as object), reason: "unavailable" });
    if (!parsed.success) { finish("protocol"); return; }

    const message = parsed.data;
    if (message.type === "presence") {
      const entry: Presence = { peerId: message.peerId, actor: message.actor, name: message.name, cursor: message.cursor, selection: message.selection };
      if (!mine.has(entry.peerId)) changePresence(() => others.set(entry.peerId, { entry, heardAt: Date.now() }));
      return;
    }
    if (message.type === "presence_left") {
      if (others.has(message.peerId)) changePresence(() => others.delete(message.peerId));
      return;
    }
    if (message.type === "loading") return; // the room is still opening: hearing it at all (lastHeard) was the point
    if (message.type === "status") {
      readOnly = message.readOnly;
      onChange?.();
      flush(); // writable again: the held edits go out, in order
      return;
    }

    const [revisionBefore, pendingBefore] = [replica.revision, replica.pendingCount];
    const effects = replica.receive(message);
    for (const { opId, outcome } of effects.settled) settle(opId, outcome); // BEFORE a fatal end: these ops have left `pending`, so abandon() could not report them
    if (effects.fatal) { finish(effects.fatal); return; }
    if (message.type === "op") onOp?.(message);
    if (message.type === "welcome") {
      readOnly = message.readOnly ?? false;
      if (message.you !== undefined) mine.add(message.you);
      const here = (message.peers ?? []).filter((entry) => !mine.has(entry.peerId));
      // The room's list replaces ours: whoever we knew on the old connection may be long gone.
      changePresence(() => { others = new Map(here.map((entry) => [entry.peerId, { entry, heardAt: Date.now() }])); });
      ownSentAt = 0; // the new room has never heard of us
      endPause(); // a pause belonged to the old connection
      liveSince = Date.now();
      setStatus("live");
    }
    if (message.type === "welcome") sendOwn();
    for (const rejection of effects.rejected) onRejected?.(rejection);
    // The picture changed, or what is still unsaved did (an acknowledgement changes only that).
    if (replica.revision !== revisionBefore || replica.pendingCount !== pendingBefore) onChange?.();
    // A refusal from a room that said it is read-only: held, not a reason to reconnect. It says when it is writable.
    const held = readOnly && message.type === "rejected" && message.reason === "unavailable";
    if (effects.resync && !held) { resync(); return; }
    // The room's budget is spent: say nothing until it has refilled (+ jitter, so that the peers of a
    // busy room do not all return at once). The refused ops are unsent again and go out first.
    if (effects.pauseMs !== undefined && pauseTimer === undefined) pauseTimer = setTimeout(() => { endPause(); flush(); }, effects.pauseMs * (1 + Math.random() / 4));
    flush(); // an answer frees a place in the window
  }

  async function open(): Promise<void> {
    // close() may have come first: connectPeer() only SCHEDULES this, and React's StrictMode (in
    // development) mounts, cleans up and mounts again within one tick. Without this line the peer
    // that was closed connected anyway, and nothing ever closed it again.
    if (closedBecause !== undefined) return;
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
    let mine: WebSocket;
    try {
      mine = new WebSocketImpl(target.wsUrl, ["noon.v1", target.token]);
    } catch {
      retryLater(); // a URL the constructor refuses. Thrown here it would be an unhandled rejection: in Node, the end of the process.
      return;
    }
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
  // so silence while we WAIT for something (the welcome, or an answer to an op) is the only sign of a
  // half-open connection. A peer that only reads has nothing to time: E2.6's presence traffic fixes that.
  const watchdog = setInterval(() => {
    // ponytail: while read-only nothing is timed, so a connection that dies half-open then is noticed only by
    // the next edit after "writable" (or by presence going quiet); upgrade: an application-level ping.
    const waiting = (status === "connecting" && socket !== undefined) || (status === "live" && replica.pendingCount > 0 && pauseTimer === undefined && !readOnly);
    if (waiting && Date.now() - lastHeard > ackTimeoutMs) resync();
  }, ackTimeoutMs / 2);
  (watchdog as { unref?: () => void }).unref?.(); // in Node, a timer must not keep a finished script alive

  // Forget whoever has been silent too long. One coarse timer, like the watchdog.
  const sweeper = setInterval(() => {
    const silent = [...others].filter(([, each]) => Date.now() - each.heardAt > timing.forgetAfterMs);
    if (silent.length > 0) changePresence(() => { for (const [peerId] of silent) others.delete(peerId); });
  }, timing.forgetAfterMs / 4);
  (sweeper as { unref?: () => void }).unref?.();

  // Not now: a callback that runs before connectPeer has returned cannot use the peer it is given to.
  queueMicrotask(() => void open());

  return {
    /** What the user sees: confirmed edits plus our own unconfirmed ones. Read only. */
    get doc(): Doc { return replica.doc; },
    // Before the first open() (a microtask away) the variable says "closed" so that the first onStatus is
    // "connecting"; a caller must never see that: "closed" means ended for good, with closedBecause set.
    get status(): PeerStatus { return status === "closed" && closedBecause === undefined ? "connecting" : status; },
    /** The room cannot save edits right now (its storage is down): submit() refuses, and edits already made wait. */
    get readOnly(): boolean { return readOnly; },
    /** Why the peer ended for good: a close code, "protocol", "no_session" or "closed_by_caller". */
    get closedBecause(): string | undefined { return closedBecause; },
    get pendingCount(): number { return replica.pendingCount; },
    /** Goes up whenever `doc` changes. `doc` is edited in place, so THIS is what a UI subscribes to (React: the useSyncExternalStore snapshot). */
    get revision(): number { return replica.revision; },

    /** Everyone else in the document, as last heard. A NEW array whenever presenceRevision moves. */
    get others(): readonly Presence[] { return [...others.values()].map((each) => each.entry); },
    get presenceRevision(): number { return presenceRevision; },
    /** Where our pointer is and what we have selected. A peer that never calls this has no presence (the AI worker, the git peer). */
    setPresence(next: OwnPresence): void {
      own = next;
      sendOwn(); // now if the interval allows, otherwise (re)scheduled for when it does; it always carries the latest state
    },

    /** Make an edit. Shown at once; sent now, or after the next welcome if we are not live. */
    submit(op: Op): Submitted {
      // A peer that has ended accepts nothing: finish() has already reported what was lost, and nothing
      // would ever answer (or even send) this op, so its `settled` would hang for ever.
      if (closedBecause !== undefined) return { ok: false, reason: "not_ready" };
      // Said at once, not queued behind a room that cannot save: a person sees why, a program (the AI, the git peer) stops or waits.
      if (readOnly) return { ok: false, reason: "read_only" };
      const waitingBefore = replica.pendingCount;
      const result = replica.local(op);
      if (!result.ok) return result;
      // An edit that changes nothing is never sent, so nobody will answer it: it is settled already.
      const settled = result.queued ? new Promise<Outcome>((resolve) => waiting.set(result.opId, resolve)) : Promise.resolve<Outcome>({ ok: true });
      if (waitingBefore === 0 && replica.pendingCount === 1) lastHeard = Date.now(); // the silence clock starts with the first thing we wait for
      flush();
      onChange?.();
      return { ok: true, opId: result.opId, settled };
    },
    /** What the SERVER has said, in its order, and how far. Codegen and the git peer project from this, never from the guess. */
    get confirmed(): Doc { return replica.confirmed; },
    get seq(): number { return replica.seq; },
    close(): void { finish("closed_by_caller"); },
  };
}

