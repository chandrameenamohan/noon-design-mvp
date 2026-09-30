// DRILL 2 · one bug from Lesson 6 is planted in this file. Find it and fix it HERE.
//
// The room, cut down to durability. The real one is `createRoom` in apps/sync/src/room.ts; this copy keeps the
// one-at-a-time queue, the dedupe memory, the journal, the read-only fall and recover(), and drops validation,
// budgets, limits and presence. The ideas are the same: an op is refused, or it is made durable, applied and
// announced; a resend gets the answer its first sending got; and a room whose journal fails says so to everyone,
// acknowledges nothing, and catches up with the journal before it writes again.
import type { Doc, Op, SequencedOp, ServerMessage } from "@noon/contracts";
import { applyOpInto } from "../../../packages/doc-model/src/index.ts";

/** Where accepted ops are made durable: op_journal, or a stand-in in memory with the table's two unique keys. */
export type Journal = {
  /** Resolves once the op is durable: undefined, or the op this sender's opId ALREADY became. Rejects: not durable. */
  append(op: SequencedOp): Promise<SequencedOp | undefined>;
  /** Every op journaled after `seq`, in order. */
  since(seq: number): Promise<SequencedOp[]>;
};
export type Peer = { id: string; send(message: ServerMessage): void };
export type ClientOp = { opId: string; op: Op };

export function createDurableRoom({ doc, seq = 0, journal }: { doc: Doc; seq?: number; journal: Journal }) {
  const peers = new Set<Peer>();
  // "sender:opId" -> what it became. Keyed by SENDER: every broadcast shows every opId to every peer.
  const remembered = new Map<string, SequencedOp>();
  let readOnly = false;
  let tail: Promise<void> = Promise.resolve();

  const broadcast = (message: ServerMessage): void => { for (const each of peers) each.send(message); };

  /** Applied here, remembered, and announced to everyone: the sender's copy is its acknowledgement. */
  function accept(sequenced: SequencedOp): void {
    applyOpInto(doc, sequenced.op);
    seq = sequenced.seq;
    remembered.set(`${sequenced.actor.id}:${sequenced.opId}`, sequenced);
    broadcast({ type: "op", ...sequenced });
  }

  function storageFailed(): void {
    if (readOnly) return;
    readOnly = true;
    broadcast({ type: "status", readOnly: true }); // to everyone, and BEFORE the refusal that caused it
  }

  async function handle(peer: Peer, { opId, op }: ClientOp): Promise<void> {
    const refuse = (): void => {
      storageFailed();
      peer.send({ type: "rejected", opId, reason: "unavailable" });
    };
    if (!peers.has(peer)) return;
    // Before the dedupe: even an answer from memory is an acknowledgement, and a read-only room gives none.
    if (readOnly) { refuse(); return; }

    // 1. Dedupe FIRST: a client that never saw its acknowledgement sends the op again and gets the original answer.
    const before = remembered.get(`${peer.id}:${opId}`);
    if (before) { peer.send({ type: "op", ...before }); return; }

    // 2. Apply and announce, then make durable. The sender hears its acknowledgement without waiting on the
    //    database, and a failed write is reported to it as "unavailable".
    const sequenced: SequencedOp = { seq: seq + 1, opId, actor: { kind: "user", id: peer.id }, op };
    accept(sequenced);
    let original;
    try {
      original = await journal.append(sequenced);
    } catch {
      refuse();
      return;
    }
    // A resend the room had forgotten: the journal's unique key caught it, and the original answer goes back.
    if (original) peer.send({ type: "op", ...original });
  }

  return {
    get seq() { return seq; },
    get readOnly() { return readOnly; },
    /** The live document. The room edits it in place: read it, never keep or change it. */
    get doc() { return doc; },

    join(peer: Peer): void {
      peers.add(peer);
      peer.send({ type: "welcome", doc: structuredClone(doc), seq, ...(readOnly ? { readOnly } : {}) });
    },
    leave(peer: Peer): void { peers.delete(peer); },

    /** Resolves when this op has been fully handled (accepted and broadcast, or refused). Never rejects. */
    submit(peer: Peer, clientOp: ClientOp): Promise<void> {
      const done = tail.then(() => handle(peer, clientOp));
      tail = done.catch(() => undefined);
      return tail;
    },

    /**
     * Leaves read-only if the journal answers again: first REPLAYS whatever it holds past the room's seq (an
     * append whose reply was lost, or a rival's row), then tells every peer "writable". Takes its turn in the queue.
     */
    recover(): Promise<boolean> {
      const done = tail.then(async () => {
        if (!readOnly) return true;
        let missed;
        try {
          missed = await journal.since(seq);
        } catch {
          return false;
        }
        for (const row of missed) accept(row);
        readOnly = false;
        broadcast({ type: "status", readOnly: false });
        return true;
      });
      tail = done.then(() => undefined, () => undefined);
      return done.catch(() => false);
    },
  };
}
