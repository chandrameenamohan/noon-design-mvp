import type { Actor, ClientMessage, ClientOp, Doc, Manifest, Op, Presence, SequencedOp, ServerMessage } from "@noon/contracts";
import { applyOpInto, changes, nodeOf, validate } from "@noon/doc-model";

/**
 * Whoever is connected. The room never sees a socket: a peer is who it is (from its VERIFIED
 * session, never from a message) and a way to send to it.
 * `send` must not keep the message object: the room may reuse or mutate what it points to.
 */
export type Peer = {
  actor: Actor;
  /** The session this connection was opened with: what presence, role checks and revocation look up. */
  session: { userId: string; orgId: string; expiresAt: number };
  send(message: ServerMessage): void;
  /** The same, already serialised. A broadcast is turned into JSON ONCE, not once per recipient. */
  sendText?(text: string): void;
  /** What presence shows for this connection; from the verified session. */
  name?: string;
  /** Ends this peer's connection. Called for a peer that keeps sending while it is being refused. */
  kick?(): void;
};

/**
 * A token bucket per actor: `burst` ops at once, refilled at `perSecond`. A STRIKE is an op that
 * arrives sooner than the peer was told to wait; `maxStrikes` in a row and the peer is dropped.
 * INVARIANT: maxStrikes must be larger than peer-client's window (50): the ops that were already on
 * the wire when the first refusal went out arrive "too soon" through no fault of the client.
 */
export type RateLimit = { perSecond: number; burst: number; maxStrikes: number };
// A person dragging a node makes about 60 ops a second.
const DEFAULT_RATE: RateLimit = { perSecond: 100, burst: 200, maxStrikes: 500 };
const MAX_RETRY_AFTER_MS = 60_000;
const REMEMBERED_NO_OPS = 2000;
const WORTH_RETURNING_FOR = 8; // tokens
// Presence faster than this is dropped, not queued: only the latest pointer position matters.
// peer-client sends at most every 50 ms, so an honest client never loses one.
const MIN_PRESENCE_INTERVAL_MS = 25;

/**
 * Where accepted ops are made durable (the op journal, E6.1a). The room's memory of what it applied is
 * bounded and dies with it; the journal's is neither, so with one the room can answer ANY resend.
 */
export type Journal = {
  /** Resolves once the op is durable: undefined, or the op this sender's opId ALREADY became. Rejects: not durable. */
  append(op: SequencedOp): Promise<SequencedOp | undefined>;
  /** What this sender's opId became, if it was ever journaled. */
  find(actorId: string, opId: string): Promise<SequencedOp | undefined>;
  /** Was this node id ever added (keystone 4: a removed id is never added again)? */
  everAdded(nodeId: string): Promise<boolean>;
};

export type RoomLimits = {
  maxNodes: number;
  /** The root is depth 0; a node may sit at depth `maxDepth`, no deeper. */
  maxDepth: number;
  /** How many applied ops the room can still answer a resend for, and how many bytes they may hold. */
  rememberedOps: number;
  rememberedBytes: number;
};
const DEFAULT_LIMITS: RoomLimits = { maxNodes: 5000, maxDepth: 64, rememberedOps: 20_000, rememberedBytes: 8 * 1024 * 1024 };

type Options = {
  doc: Doc;
  seq?: number;
  manifest: Manifest;
  limits?: Partial<RoomLimits>;
  /**
   * Makes an op durable BEFORE anyone hears of it. If the append rejects, the op is not applied, nobody
   * receives it, and its sequence number is not used up. Without one nothing is kept (tests, the simulator).
   */
  journal?: Journal;
  rate?: Partial<RateLimit>;
  /** The room has no clock of its own: the caller lends it one, and a test lends it a hand-wound one. */
  now?: () => number;
  /** How a connection gets its presence id. Injected, like the clock, so that a test can predict it. */
  mintPeerId?: () => string;
};

/**
 * One document's room: the ONLY thing that puts ops in order (SPEC §2.1). Pure logic over an
 * in-memory document: no sockets, no clock, no I/O of its own, so every rule is testable directly
 * and the reconcile simulator drives this very code.
 *
 * Ops are handled ONE AT A TIME through a queue. Node never interrupts a function halfway, but
 * the journal is awaited, and without the queue a second op would be validated against a document
 * the first has not changed yet: two peers could both "successfully" add the same node id.
 */
export function createRoom({ doc, seq = 0, manifest, limits: overrides, journal, rate: rateOverrides, now = Date.now, mintPeerId = () => crypto.randomUUID() }: Options) {
  const limits: RoomLimits = { ...DEFAULT_LIMITS, ...overrides };
  const rate: RateLimit = { ...DEFAULT_RATE, ...rateOverrides };
  const peers = new Set<Peer>();
  let nodeCount = Object.keys(doc.nodes).length;

  // What the room can still vouch for: "sender:opId" -> what it became. Insertion-ordered, so the
  // oldest is first. Keyed by SENDER too: every broadcast shows every opId to every peer, and a peer
  // that replayed someone else's opId must not get their answer while its own op is thrown away.
  // With a journal this is only a cache: what fell out of it (or died with the last room) is asked of the journal.
  const remembered = new Map<string, { op: SequencedOp; bytes: number }>();
  // Ops that changed nothing, so that a resend gets the same answer instead of a second look at a
  // document that has moved on. Their OWN small memory: they cost their sender almost nothing, and in
  // the map above a flood of them would push out real ops and turn honest resends into "stale".
  // ponytail: a no-op that falls out of here is judged afresh if it is resent; the worst case is one
  // old value written late. The journal cannot help (a no-op has no row): keep this.
  const rememberedNoOps = new Set<string>();
  let rememberedBytes = 0;
  // Everything up to this seq may have been applied and forgotten. A room loaded from storage starts
  // here: it remembers nothing about the ops that built the document it was given.
  let forgottenUpTo = seq;
  let tail: Promise<void> = Promise.resolve();

  // Budgets are kept per ACTOR (kind + id + run), not per connection: otherwise reconnecting would be
  // a free refill. An agent run gets its own, so that it cannot spend the budget of the person who started it.
  // ponytail: never pruned; one small entry per actor that ever edited here, for as long as the room lives.
  // ponytail: a user could start many runs to multiply their budget. One unfinished run per DOCUMENT is
  // enforced (E3.1); a cap per user and per org is F31 (E9.6).
  const buckets = new Map<string, { tokens: number; at: number }>();
  // Per CONNECTION: the op this peer was first refused for, when it may come back, and its strikes.
  const throttled = new WeakMap<Peer, { blockedOn: string; notBefore: number; strikes: number }>();
  const bucketKey = ({ kind, id, runId }: Actor): string => `${kind}:${id}:${runId ?? ""}`;

  /** Takes one token (unless `take` is false), or says how many ms until there is one. 0 = taken. */
  function spend(actor: Actor, take = true): number {
    const key = bucketKey(actor);
    const bucket = buckets.get(key) ?? { tokens: rate.burst, at: now() };
    // max(0): a clock that was corrected BACKWARDS must not turn into a debt of that many milliseconds.
    bucket.tokens = Math.min(rate.burst, bucket.tokens + (Math.max(0, now() - bucket.at) / 1000) * rate.perSecond);
    bucket.at = now();
    buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      if (take) bucket.tokens -= 1;
      return 0;
    }
    // "Come back when it is worth it": when a few tokens have gathered, not the first one. A client told
    // to return for ONE token sends one op, is refused on the next, and pays a refusal for every op.
    // Capped: a budget of 0 per second would make this Infinity, which JSON writes as null.
    const worthIt = Math.min(rate.burst, WORTH_RETURNING_FOR);
    return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(((worthIt - bucket.tokens) / rate.perSecond) * 1000));
  }

  /** Refuses the op if this peer is over budget. True = refused (or dropped). Runs ON ARRIVAL, outside the queue. */
  function overBudget(peer: Peer, opId: string): boolean {
    const state = throttled.get(peer);
    // Once an op is refused, everything AFTER it is refused too until that op comes back. Otherwise
    // the bucket refills mid-stream, a child is let in while its parent was refused, and the child is
    // lost for good as "gone".
    const outOfTurn = state !== undefined && state.blockedOn !== opId;
    const waitMs = outOfTurn ? Math.max(Math.ceil(1000 / Math.max(rate.perSecond, 1)), spend(peer.actor, false)) : spend(peer.actor);
    if (waitMs === 0) {
      throttled.delete(peer);
      return false;
    }
    // Only an op that came back TOO SOON is a strike. A peer that waits as told and is refused again
    // (another tab of the same user took the token) is unlucky, not abusive.
    const tooSoon = state === undefined || now() < state.notBefore;
    const strikes = (state?.strikes ?? 0) + (tooSoon ? 1 : 0);
    throttled.set(peer, { blockedOn: state?.blockedOn ?? opId, notBefore: outOfTurn ? state.notBefore : now() + waitMs, strikes });
    if (strikes > rate.maxStrikes) {
      peers.delete(peer); // it is not listening to "slow down": stop talking to it
      peer.kick?.();
    } else peer.send({ type: "rejected", opId, reason: "rate_limited", retryAfterMs: waitMs });
    return true;
  }

  const depthOf = (nodeId: string): number => {
    let depth = 0;
    for (let at = nodeOf(doc, nodeId); at?.parentId != null; at = nodeOf(doc, at.parentId)) depth++;
    return depth;
  };
  /** Levels below and including `nodeId`: a leaf is 1. Iterative, like every walk over a document. */
  const heightOf = (nodeId: string): number => {
    let height = 0;
    for (let level = [nodeId]; level.length > 0; height++) level = level.flatMap((id) => nodeOf(doc, id)?.children ?? []);
    return height;
  };

  function overLimit(op: Op): boolean {
    if (op.type === "add_node") return nodeCount >= limits.maxNodes || depthOf(op.parentId) + 1 > limits.maxDepth;
    // A move can deepen a whole subtree: without this check the depth cap is escaped in a dozen ops.
    if (op.type === "move_node") return depthOf(op.newParentId) + heightOf(op.nodeId) > limits.maxDepth;
    return false;
  }

  /** To everyone (but `except`). Serialised once: with N peers at 20 presence messages a second each, once per recipient is N x N x 20 stringifies. */
  function broadcast(message: ServerMessage, except?: Peer): void {
    let text: string | undefined;
    for (const each of peers) {
      if (each === except) continue;
      if (each.sendText) each.sendText((text ??= JSON.stringify(message)));
      else each.send(message);
    }
  }

  // Presence lives HERE and nowhere else: in this process's memory, per connection, gone with it.
  const present = new Map<Peer, { entry: Presence; at: number }>();
  const entryOf = (peer: Peer): Presence => present.get(peer)?.entry ?? { peerId: "", actor: peer.actor, name: peer.name ?? "", cursor: null, selection: null };

  function remember(key: string, op: SequencedOp): void {
    const bytes = JSON.stringify(op.op).length;
    remembered.set(key, { op, bytes });
    rememberedBytes += bytes;
    while (remembered.size > limits.rememberedOps || rememberedBytes > limits.rememberedBytes) {
      const oldest = remembered.entries().next().value;
      if (!oldest) break;
      remembered.delete(oldest[0]);
      rememberedBytes -= oldest[1].bytes;
      forgottenUpTo = Math.max(forgottenUpTo, oldest[1].op.seq);
    }
  }

  async function handle(peer: Peer, { opId, baseSeq, op }: ClientOp): Promise<void> {
    const refuse = (reason: Extract<ServerMessage, { type: "rejected" }>["reason"]): void => {
      peer.send({ type: "rejected", opId, reason });
    };

    if (!peers.has(peer)) return; // dropped while this op waited in the queue

    // 1. Dedupe FIRST. A client that never saw its acknowledgement sends the op again and must get
    //    the original answer; validating first would turn an ordinary retry into "duplicate_node".
    const key = `${peer.actor.id}:${opId}`;
    const before = remembered.get(key);
    if (before) {
      peer.send({ type: "op", ...before.op });
      return;
    }
    if (rememberedNoOps.has(key)) {
      peer.send({ type: "ack", opId });
      return;
    }
    // An op written before the oldest thing the room remembers MAY already have been applied. The
    // journal can tell: found, it gets its original answer; not found, it never was, and is judged now.
    // Without a journal the room cannot tell, and applying it twice would move a node twice: resync.
    if (baseSeq < forgottenUpTo) {
      if (!journal) {
        refuse("stale");
        return;
      }
      let original;
      try {
        original = await journal.find(peer.actor.id, opId);
      } catch {
        refuse("unavailable");
        return;
      }
      if (original) {
        peer.send({ type: "op", ...original });
        return;
      }
    }

    // 2. The document's rules first (they give the precise reason: a move into its own subtree is a
    //    "cycle", not a depth problem), then the room's limits. A refusal goes to the sender only.
    const verdict = validate(doc, op, manifest);
    if (!verdict.ok) {
      refuse(verdict.reason);
      return;
    }
    if (overLimit(op)) {
      refuse("document_limit");
      return;
    }
    // Keystone 4: validate() only sees the document as it is; an id that was removed is in the journal.
    // ponytail: one indexed read per add (adds are rare next to drags); without a journal, unchecked.
    if (op.type === "add_node" && journal) {
      let reused;
      try {
        reused = await journal.everAdded(op.nodeId);
      } catch {
        refuse("unavailable");
        return;
      }
      if (reused) {
        refuse("duplicate_node");
        return;
      }
    }

    // An op that changes nothing (the value is already that) is answered and goes no further: no seq,
    // no journal row, no broadcast. Remembered like any other, so that its resend is still a no-op.
    if (!changes(doc, op)) {
      rememberedNoOps.add(key);
      if (rememberedNoOps.size > REMEMBERED_NO_OPS) rememberedNoOps.delete(rememberedNoOps.values().next().value ?? key);
      peer.send({ type: "ack", opId });
      return;
    }

    // 3. Durable first, then applied, then announced. The number is only TAKEN once the op is durable,
    //    so a failed write leaves no gap. The ACTOR comes from the verified session (SPEC §2.3).
    const sequenced: SequencedOp = { seq: seq + 1, opId, actor: peer.actor, op };
    let original;
    try {
      original = await journal?.append(sequenced);
    } catch {
      refuse("unavailable");
      return;
    }
    // A resend the room had forgotten, with a baseSeq that got it past the check above (a buggy or lying
    // client). The journal's unique key caught it: the original answer, and nothing is applied twice.
    if (original) {
      peer.send({ type: "op", ...original });
      return;
    }
    applyOpInto(doc, op);
    seq = sequenced.seq;
    nodeCount = op.type === "add_node" ? nodeCount + 1 : op.type === "remove_node" ? Object.keys(doc.nodes).length : nodeCount;
    remember(key, sequenced);
    broadcast({ type: "op", ...sequenced }); // the sender's copy is its acknowledgement
  }

  return {
    get peerCount() { return peers.size; },
    get peers(): ReadonlySet<Peer> { return peers; },
    get seq() { return seq; },
    /** The live document. The room edits it in place: read it, never keep or change it. */
    get doc() { return doc; },

    join(peer: Peer): void {
      // Unique for good, not only in this room: a client remembers its own past ids to recognise its
      // old, not-yet-reaped connection after a reconnect, and "p1" would be reused by a reloaded room.
      const peerId = mintPeerId();
      const others = [...present.values()].map((each) => each.entry);
      peers.add(peer);
      present.set(peer, { entry: { ...entryOf(peer), peerId }, at: -Infinity });
      // A COPY: the room goes on editing `doc` in place, and a message must not change after it is sent.
      peer.send({ type: "welcome", doc: structuredClone(doc), seq, you: peerId, peers: others });
    },

    leave(peer: Peer): void {
      peers.delete(peer);
      const was = present.get(peer);
      present.delete(peer);
      if (was) broadcast({ type: "presence_left", peerId: was.entry.peerId });
    },

    /** Relays where a peer points. Not an op: no queue, no seq, no persist. Too fast = dropped (the next one replaces it anyway). */
    presence(peer: Peer, { cursor, selection }: Omit<Extract<ClientMessage, { type: "presence" }>, "type">): void {
      const was = present.get(peer);
      if (!was || !peers.has(peer) || now() - was.at < MIN_PRESENCE_INTERVAL_MS) return;
      const entry: Presence = { ...was.entry, cursor, selection };
      present.set(peer, { entry, at: now() });
      broadcast({ type: "presence", ...entry }, peer);
    },

    /** Resolves when this op has been fully handled (accepted and broadcast, or refused). Never rejects. */
    submit(peer: Peer, clientOp: ClientOp): Promise<void> {
      // The budget is charged HERE, as the op arrives, not when the queue reaches it: behind a slow
      // journal the bucket would refill while ops wait, nothing would ever be refused, and a flood
      // would simply pile up in memory. Every submission costs the same, whatever it turns out to be.
      if (!peers.has(peer) || overBudget(peer, clientOp.opId)) return tail;
      const done = tail.then(() => handle(peer, clientOp));
      tail = done.catch(() => undefined); // one failure must not jam the queue for every later op
      return tail;
    },

    /** Resolves when every op submitted so far has been handled. */
    settled: (): Promise<void> => tail,
  };
}

export type Room = ReturnType<typeof createRoom>;
