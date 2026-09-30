// DRILL 2 · one bug from Lesson 7 is planted in this file. Find it and fix it HERE.
//
// A room on the sync node that holds the document's lease, cut down to the fence (E7.3, F22). The real one is
// `createRoom` in apps/sync/src/room.ts behind the journal that server.ts builds in load(); this copy keeps the
// one-at-a-time queue, the fenced append and the drop (every peer sent to the new owner, nothing more accepted),
// and leaves out validation, dedupe, budgets, read-only mode, presence and snapshots. The ideas are the same: this
// opening of the room CLAIMED the document under its lease token before it read the journal, and from then on a
// row may land only while the document still names this claim. An owner frozen past its lease (docker pause, a GC
// pause, a partition from Redis) still believes it holds the room when it wakes; the fence is what stops its
// writes, and a refused write is the moment it learns.
import type { Doc, Op, SequencedOp, ServerMessage } from "@noon/contracts";
import { applyOpInto } from "../../../packages/doc-model/src/index.ts";

/** The append was refused because the document names another opening's claim: a newer owner has the room. */
export class Fenced extends Error {}

/**
 * The document's row and its journal, as Postgres holds them: the documents row names the claim of the one opening
 * allowed to write. Every call is a round trip. The test has a stand-in in memory.
 */
export type Store = {
  /** The claim the document names now (undefined: never claimed). */
  claimOf(): Promise<string | undefined>;
  /** Writes the row, whatever the document names. */
  insert(op: SequencedOp): Promise<void>;
  /** Writes the row only if the document still names `claim`, check and write in ONE statement; otherwise throws Fenced. */
  insertIf(op: SequencedOp, claim: string): Promise<void>;
};
export type Peer = { id: string; send(message: ServerMessage): void; close(code: number): void };
export type ClientOp = { opId: string; op: Op };
/** Our close code for "another sync node owns this room": the peer asks /session again (apps/sync/src/server.ts). */
export const ROOM_ELSEWHERE = 4409;

export function createFencedRoom({ doc, seq = 0, store, claim }: { doc: Doc; seq?: number; store: Store; claim: string }) {
  const peers = new Set<Peer>();
  let lost = false;
  let tail: Promise<void> = Promise.resolve();

  const broadcast = (message: ServerMessage): void => { for (const each of peers) each.send(message); };

  /** Applied here and announced to everyone: the sender's copy is its acknowledgement. */
  function accept(sequenced: SequencedOp): void {
    applyOpInto(doc, sequenced.op);
    seq = sequenced.seq;
    broadcast({ type: "op", ...sequenced });
  }

  /** Fenced: a newer owner has the document. Stop at once; every peer asks /session again and lands with that owner. */
  function drop(): void {
    if (lost) return;
    lost = true;
    for (const each of peers) each.close(ROOM_ELSEWHERE);
    peers.clear();
  }

  async function handle(peer: Peer, { opId, op }: ClientOp): Promise<void> {
    if (lost || !peers.has(peer)) return;
    const sequenced: SequencedOp = { seq: seq + 1, opId, actor: { kind: "user", id: peer.id }, op };
    try {
      // Durable first (lesson 6), and only under this opening's claim (this lesson): the fence, then the write.
      if ((await store.claimOf()) !== claim) throw new Fenced("a newer owner claimed the document");
      await store.insert(sequenced);
    } catch (err) {
      // A fence is not an outage: the room is not read-only, it is over. Anything else is "try again later".
      if (err instanceof Fenced) drop();
      else peer.send({ type: "rejected", opId, reason: "unavailable" });
      return;
    }
    accept(sequenced);
  }

  return {
    get seq() { return seq; },
    /** True once the fence refused a write: this room has no peers and takes nothing more. */
    get lost() { return lost; },
    /** The live document. The room edits it in place: read it, never keep or change it. */
    get doc() { return doc; },

    join(peer: Peer): void {
      if (lost) { peer.close(ROOM_ELSEWHERE); return; }
      peers.add(peer);
      peer.send({ type: "welcome", doc: structuredClone(doc), seq });
    },
    leave(peer: Peer): void { peers.delete(peer); },

    /** Resolves when this op has been fully handled (accepted and broadcast, refused, or fenced). Never rejects. */
    submit(peer: Peer, clientOp: ClientOp): Promise<void> {
      const done = tail.then(() => handle(peer, clientOp));
      tail = done.catch(() => undefined);
      return tail;
    },
  };
}
