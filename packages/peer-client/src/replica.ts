import { ClientOp, RejectReason, type Doc, type Manifest, type Op, type ServerMessage } from "@noon/contracts";
import { applyOp, applyOpInto, emptyDoc, validate } from "@noon/doc-model";

/** An op of ours that the server refused for good. `quiet`: nothing the user needs to hear about. */
export type Rejection = { opId: string; op: Op; reason: RejectReason; quiet: boolean };

/** What the caller must do after a message: frames to send, refusals to show, or "reconnect and start from a fresh welcome". */
export type Effects = { send: ClientOp[]; rejected: Rejection[]; resync: boolean };

export type LocalResult = { ok: true; send: ClientOp } | { ok: false; reason: RejectReason | "not_ready" | "invalid_op" };

type Pending = ClientOp & { staleCount: number };

// An op that comes back "stale" is rebased and sent again; if the room STILL cannot place it, stop.
const MAX_STALE_RETRIES = 2;

/**
 * One peer's copy of a document. Pure logic: no socket, no timer, no clock, so the reconcile
 * simulator and the unit tests drive this very code (the same split as the room on the server).
 *
 * It holds TWO documents:
 *   confirmed   what the server has said, in the server's order. Never guessed at.
 *   optimistic  confirmed + every op of ours the server has not answered yet. What the user sees.
 * The invariant (tested as a property): optimistic == confirmed, then each pending op, in order.
 */
export function createReplica({ manifest }: { manifest: Manifest }) {
  let confirmed: Doc = emptyDoc();
  let optimistic: Doc = emptyDoc();
  let seq = 0;
  let ready = false;
  let pending: Pending[] = [];

  /**
   * Throw the guess away and make it again. Only the node MAP is copied; the nodes are shared.
   * That is safe because applyOpInto never edits a node: it puts a NEW node object in the map.
   * Measured on 5,000 nodes with 20 pending: about 1 ms per remote op, against 6.5 ms with structuredClone.
   */
  function rebuild(): void {
    optimistic = { ...confirmed, nodes: { ...confirmed.nodes } };
    for (const each of pending) applyOpInto(optimistic, each.op);
  }

  const wire = ({ opId, baseSeq, op }: Pending): ClientOp => ({ opId, baseSeq, op });

  function onWelcome(doc: Doc, welcomeSeq: number): Effects {
    confirmed = doc;
    seq = welcomeSeq;
    ready = true;
    rebuild();
    // Same opId: if the server did apply one of these before the connection dropped, it answers with
    // the original acknowledgement instead of applying it twice. Same baseSeq: it says what the op was
    // written against, and claiming something newer would switch the server's "stale" guard off.
    return { send: pending.map(wire), rejected: [], resync: false };
  }

  function onOp(message: Extract<ServerMessage, { type: "op" }>): Effects {
    const effects: Effects = { send: [], rejected: [], resync: false };
    if (message.seq > seq + 1) return { ...effects, resync: true }; // we missed something: touch nothing, start again from a welcome
    // ponytail: matched by opId alone. An opId is unguessable until the room has broadcast it, and by
    // then our op HAS been applied, so another peer replaying it can only end a wait that was over.
    const mineAt = pending.findIndex((each) => each.opId === message.opId);
    const wasHead = mineAt === 0;
    if (mineAt >= 0) pending = pending.filter((_, i) => i !== mineAt);
    if (message.seq <= seq) {
      // An answer to a resend, for an op the welcome ALREADY contains. Applying it again could
      // overwrite a later edit by someone else; it only tells us the op is no longer pending.
      if (mineAt >= 0) rebuild();
      return effects;
    }

    // Always the SERVER's copy of the op, never our own: an opId is only a claim, the content is the fact.
    applyOpInto(confirmed, message.op);
    seq = message.seq;
    // Two cases need no rebuild: our oldest pending op was confirmed (the guess already contains it),
    // or nothing is pending (both documents take the same op). Anything else re-orders history.
    if (mineAt >= 0 ? !wasHead : pending.length > 0) rebuild();
    else if (mineAt < 0) applyOpInto(optimistic, message.op);
    return effects;
  }

  function onRejected({ opId, reason }: Extract<ServerMessage, { type: "rejected" }>): Effects {
    const effects: Effects = { send: [], rejected: [], resync: false };
    const mine = pending.find((each) => each.opId === opId);
    if (!mine) return effects;

    // Not applied, and nothing wrong with the op: keep it, and come back through a fresh welcome so
    // that everything pending is resent IN ORDER (a later op may depend on this one).
    if (reason === RejectReason.enum.unavailable) return { ...effects, resync: true };

    if (reason === RejectReason.enum.stale) {
      // The room no longer remembers whether it applied this op. The confirmed document can tell:
      // if the op would change nothing, it is already there (or no longer makes sense). Drop it.
      const alreadyThere = applyOp(confirmed, mine.op) === confirmed;
      if (!alreadyThere && mine.staleCount < MAX_STALE_RETRIES) {
        mine.staleCount++;
        mine.baseSeq = seq; // honest again: it is now written against what we have seen
        return { ...effects, send: [wire(mine)] };
      }
      pending = pending.filter((each) => each !== mine);
      rebuild();
      return alreadyThere ? effects : { ...effects, rejected: [{ opId, op: mine.op, reason, quiet: false }] };
    }

    pending = pending.filter((each) => each !== mine);
    rebuild();
    // "gone": someone removed the node first. The canvas already shows that; there is nothing to say.
    return { ...effects, rejected: [{ opId, op: mine.op, reason, quiet: reason === RejectReason.enum.gone }] };
  }

  return {
    /** What the user sees. Read it, never change it: the replica edits it in place. */
    get doc(): Doc { return optimistic; },
    get confirmed(): Doc { return confirmed; },
    get seq(): number { return seq; },
    get pending(): readonly ClientOp[] { return pending; },

    /** An edit made here. Checked against what the user SEES, applied at once, returned ready to send. */
    local(op: Op): LocalResult {
      if (!ready) return { ok: false, reason: "not_ready" };
      const clientOp = ClientOp.safeParse({ opId: crypto.randomUUID(), baseSeq: seq, op });
      if (!clientOp.success) return { ok: false, reason: "invalid_op" }; // e.g. props over 32 KB: the server would drop the connection
      const verdict = validate(optimistic, op, manifest);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      applyOpInto(optimistic, op);
      pending.push({ ...clientOp.data, staleCount: 0 });
      return { ok: true, send: clientOp.data };
    },

    receive(message: ServerMessage): Effects {
      if (message.type === "welcome") return onWelcome(message.doc, message.seq);
      return message.type === "op" ? onOp(message) : onRejected(message);
    },
  };
}

