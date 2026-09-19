import type { Actor, ClientOp, Doc, Manifest, Op, SequencedOp, ServerMessage } from "@noon/contracts";
import { applyOpInto, nodeOf, validate } from "@noon/doc-model";

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
   * Makes an op durable BEFORE anyone hears of it (the journal, from E6.1a). If it rejects, the op
   * is not applied, nobody receives it, and its sequence number is not used up.
   */
  persist?: (op: SequencedOp) => Promise<void>;
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
export function createRoom({ doc, seq = 0, manifest, limits: overrides, persist }: Options) {
  const limits: RoomLimits = { ...DEFAULT_LIMITS, ...overrides };
  const peers = new Set<Peer>();
  let nodeCount = Object.keys(doc.nodes).length;

  // What the room can still vouch for: "sender:opId" -> what it became. Insertion-ordered, so the
  // oldest is first. Keyed by SENDER too: every broadcast shows every opId to every peer, and a peer
  // that replayed someone else's opId must not get their answer while its own op is thrown away.
  // ponytail: this memory dies with the room. From E6.1a the journal's unique index is the real one.
  const remembered = new Map<string, { op: SequencedOp; bytes: number }>();
  let rememberedBytes = 0;
  // Everything up to this seq may have been applied and forgotten. A room loaded from storage starts
  // here: it remembers nothing about the ops that built the document it was given.
  let forgottenUpTo = seq;
  let tail: Promise<void> = Promise.resolve();

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

    // 1. Dedupe FIRST. A client that never saw its acknowledgement sends the op again and must get
    //    the original answer; validating first would turn an ordinary retry into "duplicate_node".
    const key = `${peer.actor.id}:${opId}`;
    const before = remembered.get(key);
    if (before) {
      peer.send({ type: "op", ...before.op });
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
