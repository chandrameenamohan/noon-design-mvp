import type { Actor, ClientOp, Doc, Manifest, SequencedOp, ServerMessage } from "@noon/contracts";
import { applyOpInto, nodeOf, validate } from "@noon/doc-model";

/** Whoever is connected: the room never sees a socket, only a way to send and who the peer is. */
export type Peer = { actor: Actor; send(message: ServerMessage): void };

export type RoomLimits = { maxNodes: number; maxDepth: number };
export const DEFAULT_LIMITS: RoomLimits = { maxNodes: 5000, maxDepth: 64 };

// ponytail: the memory of applied opIds is bounded and lives only as long as the room. From E6.1a
// the journal's unique (document_id, op_id) index is the real memory and survives a restart.
const REMEMBERED_OPS = 5000;

/**
 * One document's room: the ONLY thing that puts ops in order (SPEC §2.1). Pure logic over an
 * in-memory document: no sockets, no clock, no I/O, so every rule here is testable directly and
 * the reconcile simulator can drive the very same code.
 *
 * Node runs one piece of JavaScript at a time, so `submit` is never interrupted halfway: ops are
 * sequenced one after another without a lock. That is the single-threaded event loop paying rent.
 */
export function createRoom({ doc, seq = 0, manifest, limits = DEFAULT_LIMITS }: { doc: Doc; seq?: number; manifest: Manifest; limits?: RoomLimits }) {
  const peers = new Set<Peer>();
  const applied = new Map<string, SequencedOp>(); // opId -> what it became; insertion-ordered, so the oldest is first

  function depthOf(nodeId: string): number {
    let depth = 0;
    for (let at = nodeOf(doc, nodeId); at?.parentId != null; at = nodeOf(doc, at.parentId)) depth++;
    return depth;
  }

  return {
    get peerCount() { return peers.size; },
    get seq() { return seq; },

    join(peer: Peer): void {
      peers.add(peer);
      peer.send({ type: "welcome", doc, seq });
    },

    leave(peer: Peer): void {
      peers.delete(peer);
    },

    submit(peer: Peer, { opId, op }: ClientOp): void {
      // 1. Dedupe FIRST. A client that never saw its acknowledgement sends the op again; it must get
      //    the original answer. Validating first would turn an ordinary retry into "duplicate_node".
      const before = applied.get(opId);
      if (before) {
        peer.send({ type: "op", ...before });
        return;
      }

      // 2. The room's own limits, then the document rules. A refusal goes to the sender only.
      if (op.type === "add_node" && (Object.keys(doc.nodes).length >= limits.maxNodes || depthOf(op.parentId) + 1 >= limits.maxDepth)) {
        peer.send({ type: "rejected", opId, reason: "document_limit" });
        return;
      }
      const verdict = validate(doc, op, manifest);
      if (!verdict.ok) {
        peer.send({ type: "rejected", opId, reason: verdict.reason });
        return;
      }

      // 3. Accept: apply in place, give it the next number, remember it, tell everyone.
      //    The sender's copy of the broadcast is its acknowledgement.
      applyOpInto(doc, op);
      seq += 1;
      // The ACTOR comes from the peer's verified session, never from the message (SPEC §2.3).
      const sequenced: SequencedOp = { seq, opId, actor: peer.actor, op };
      applied.set(opId, sequenced);
      if (applied.size > REMEMBERED_OPS) applied.delete(applied.keys().next().value ?? "");
      for (const each of peers) each.send({ type: "op", ...sequenced });
    },
  };
}

export type Room = ReturnType<typeof createRoom>;
