import type { Actor, ClientOp, Doc, Manifest, Op, SequencedOp, ServerMessage } from "@noon/contracts";
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
  /** Ends this peer's connection. Called for a peer that keeps sending while it is being refused. */
  kick?(): void;
};

/** A token bucket per actor: `burst` ops at once, refilled at `perSecond`. `maxStrikes` refusals in a row and the peer is dropped. */
export type RateLimit = { perSecond: number; burst: number; maxStrikes: number };
// A person dragging a node makes about 60 ops a second; peer-client keeps at most 50 unanswered ops
// on the wire, so an honest client stays inside this even when it resends 2,000 edits made offline.
const DEFAULT_RATE: RateLimit = { perSecond: 100, burst: 200, maxStrikes: 500 };

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
   * Makes an op durable BEFORE anyone hears of it (the journal, from E6.1a). If it rejects, the op
   * is not applied, nobody receives it, and its sequence number is not used up.
   */
  persist?: (op: SequencedOp) => Promise<void>;
  rate?: Partial<RateLimit>;
  /** The room has no clock of its own: the caller lends it one, and a test lends it a hand-wound one. */
  now?: () => number;
};

/**
 * One document's room: the ONLY thing that puts ops in order (SPEC §2.1). Pure logic over an
 * in-memory document: no sockets, no clock, no I/O of its own, so every rule is testable directly
 * and the reconcile simulator drives this very code.
 *
 * Ops are handled ONE AT A TIME through a queue. Node never interrupts a function halfway, but
 * `persist` is awaited, and without the queue a second op would be validated against a document
 * the first has not changed yet: two peers could both "successfully" add the same node id.
 */
export function createRoom({ doc, seq = 0, manifest, limits: overrides, persist, rate: rateOverrides, now = Date.now }: Options) {
  const limits: RoomLimits = { ...DEFAULT_LIMITS, ...overrides };
  const rate: RateLimit = { ...DEFAULT_RATE, ...rateOverrides };
  const peers = new Set<Peer>();
  let nodeCount = Object.keys(doc.nodes).length;

  // What the room can still vouch for: "sender:opId" -> what it became. Insertion-ordered, so the
  // oldest is first. Keyed by SENDER too: every broadcast shows every opId to every peer, and a peer
  // that replayed someone else's opId must not get their answer while its own op is thrown away.
  // ponytail: this memory dies with the room. From E6.1a the journal's unique index is the real one.
  // `op: undefined` = "that one changed nothing": its resend must get the same answer, not a second look.
  const remembered = new Map<string, { op: SequencedOp | undefined; seq: number; bytes: number }>();
  let rememberedBytes = 0;
  // Everything up to this seq may have been applied and forgotten. A room loaded from storage starts
  // here: it remembers nothing about the ops that built the document it was given.
  let forgottenUpTo = seq;
  let tail: Promise<void> = Promise.resolve();

  // Budgets are kept per ACTOR, not per connection: otherwise reconnecting would be a free refill.
  // ponytail: an entry stays until a join finds it full again; one number pair per actor ever seen here.
  const buckets = new Map<string, { tokens: number; at: number }>();
  // Per CONNECTION: the op this peer was last refused for, and how many refusals in a row.
  const throttled = new WeakMap<Peer, { blockedOn: string; strikes: number }>();

  /** Takes one token (unless `take` is false), or says how many ms until there is one. 0 = taken. */
  function spend(actorId: string, take = true): number {
    const bucket = buckets.get(actorId) ?? { tokens: rate.burst, at: now() };
    bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now() - bucket.at) / 1000) * rate.perSecond);
    bucket.at = now();
    buckets.set(actorId, bucket);
    if (bucket.tokens >= 1) {
      if (take) bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - bucket.tokens) / rate.perSecond) * 1000);
  }

  /** Refuses the op if this peer is over budget. True = refused (or dropped). */
  function overBudget(peer: Peer, opId: string): boolean {
    const state = throttled.get(peer);
    // Once an op is refused, everything AFTER it is refused too until that op comes back. Otherwise
    // the bucket refills mid-stream, a child is let in while its parent was refused, and the child is
    // lost for good as "gone".
    const outOfTurn = state !== undefined && state.blockedOn !== opId;
    const waitMs = outOfTurn ? Math.max(1, spend(peer.actor.id, false)) : spend(peer.actor.id);
    if (waitMs === 0) {
      throttled.delete(peer);
      return false;
    }
    const strikes = (state?.strikes ?? 0) + 1;
    throttled.set(peer, { blockedOn: state?.blockedOn ?? opId, strikes });
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

  function remember(key: string, op: SequencedOp | undefined): void {
    const bytes = op ? JSON.stringify(op.op).length : 0;
    remembered.set(key, { op, seq, bytes });
    rememberedBytes += bytes;
    while (remembered.size > limits.rememberedOps || rememberedBytes > limits.rememberedBytes) {
      const oldest = remembered.entries().next().value;
      if (!oldest) break;
      remembered.delete(oldest[0]);
      rememberedBytes -= oldest[1].bytes;
      forgottenUpTo = Math.max(forgottenUpTo, oldest[1].seq);
    }
  }

  async function handle(peer: Peer, { opId, baseSeq, op }: ClientOp): Promise<void> {
    const refuse = (reason: Extract<ServerMessage, { type: "rejected" }>["reason"]): void => {
      peer.send({ type: "rejected", opId, reason });
    };

    // 0. The budget: every submission costs the same, whatever it turns out to be.
    if (!peers.has(peer) || overBudget(peer, opId)) return;

    // 1. Dedupe FIRST. A client that never saw its acknowledgement sends the op again and must get
    //    the original answer; validating first would turn an ordinary retry into "duplicate_node".
    const key = `${peer.actor.id}:${opId}`;
    const before = remembered.get(key);
    if (before) {
      peer.send(before.op ? { type: "op", ...before.op } : { type: "ack", opId });
      return;
    }
    // An op written before the oldest thing the room remembers MAY already have been applied, and the
    // room can no longer tell. Applying it again would move a node twice; so the client must resync.
    if (baseSeq < forgottenUpTo) {
      refuse("stale");
      return;
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

    // An op that changes nothing (the value is already that) is answered and goes no further: no seq,
    // no journal row, no broadcast. Remembered like any other, so that its resend is still a no-op.
    if (!changes(doc, op)) {
      remember(key, undefined);
      peer.send({ type: "ack", opId });
      return;
    }

    // 3. Durable first, then applied, then announced. The number is only TAKEN once the op is durable,
    //    so a failed write leaves no gap. The ACTOR comes from the verified session (SPEC §2.3).
    const sequenced: SequencedOp = { seq: seq + 1, opId, actor: peer.actor, op };
    try {
      await persist?.(sequenced);
    } catch {
      refuse("unavailable");
      return;
    }
    applyOpInto(doc, op);
    seq = sequenced.seq;
    nodeCount = op.type === "add_node" ? nodeCount + 1 : op.type === "remove_node" ? Object.keys(doc.nodes).length : nodeCount;
    remember(key, sequenced);
    const message: ServerMessage = { type: "op", ...sequenced };
    for (const each of peers) each.send(message); // the sender's copy is its acknowledgement
  }

  return {
    get peerCount() { return peers.size; },
    get peers(): ReadonlySet<Peer> { return peers; },
    get seq() { return seq; },
    /** The live document. The room edits it in place: read it, never keep or change it. */
    get doc() { return doc; },

    join(peer: Peer): void {
      peers.add(peer);
      // A COPY: the room goes on editing `doc` in place, and a message must not change after it is sent.
      peer.send({ type: "welcome", doc: structuredClone(doc), seq });
    },

    leave(peer: Peer): void {
      peers.delete(peer);
    },

    /** Resolves when this op has been fully handled (accepted and broadcast, or refused). Never rejects. */
    submit(peer: Peer, clientOp: ClientOp): Promise<void> {
      const done = tail.then(() => handle(peer, clientOp));
      tail = done.catch(() => undefined); // one failure must not jam the queue for every later op
      return tail;
    },

    /** Resolves when every op submitted so far has been handled. */
    settled: (): Promise<void> => tail,
  };
}

export type Room = ReturnType<typeof createRoom>;
