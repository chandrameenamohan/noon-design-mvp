import { ClientOp, RejectReason, type Doc, type Manifest, type Op, type ServerMessage } from "@noon/contracts";
import { applyOp, applyOpInto, checkDoc, emptyDoc, validate } from "@noon/doc-model";

/** An op of ours that the server refused for good. `quiet`: nothing the user needs to hear about. */
export type Rejection = { opId: string; op: Op; reason: RejectReason | "connection_closed"; quiet: boolean };

/** What the caller must do after a message: frames to send, refusals to show, or "reconnect and start from a fresh welcome". */
/** `fatal`: this server cannot be worked with; reconnecting would only repeat it. */
export type Effects = { rejected: Rejection[]; resync: boolean; fatal?: "document_corrupt"; /** Send nothing for this long (the server's budget). */ pauseMs?: number };

export type LocalResult = { ok: true; opId: string } | { ok: false; reason: RejectReason | "not_ready" | "invalid_op" | "too_many_pending" };

/**
 * `inFlight`: on the wire of the CURRENT connection, not answered yet.
 * `maybeApplied`: it was on the wire of an EARLIER connection, so a room we no longer talk to may have applied it.
 */
/** Everything the server says about the DOCUMENT. Presence is not the replica's business (peer.ts keeps it). */
export type DocMessage = Exclude<ServerMessage, { type: "presence" | "presence_left" }>;

type Pending = ClientOp & { staleCount: number; inFlight: boolean; maybeApplied: boolean };

// An op that comes back "stale" is rebased and sent again; if the room STILL cannot place it, stop.
const MAX_STALE_RETRIES = 2;
// The longest silence we accept on a server's say-so.
const MAX_PAUSE_MS = 30_000;

/**
 * One peer's copy of a document. Pure logic: no socket, no timer, no clock, so the reconcile
 * simulator and the unit tests drive this very code (the same split as the room on the server).
 *
 * It holds TWO documents:
 *   confirmed   what the server has said, in the server's order. Never guessed at.
 *   optimistic  confirmed + every op of ours the server has not answered yet. What the user sees.
 * The invariant (tested as a property): optimistic == confirmed, then each pending op, in order.
 */
export function createReplica({ manifest, maxPending = 2000, window = 50, mintOpId = () => crypto.randomUUID() }: { manifest: Manifest; maxPending?: number; /** How many unanswered ops may be on the wire at once. */ window?: number; /** Injected, like the room's clock: the simulator needs every run of a seed to be identical. */ mintOpId?: () => string }) {
  let confirmed: Doc = emptyDoc();
  let optimistic: Doc = emptyDoc();
  let seq = 0;
  let ready = false;
  let pending: Pending[] = [];
  // Goes up whenever `optimistic` changes. The document is edited IN PLACE, so its identity says
  // nothing; this number is what a UI compares (React: useSyncExternalStore's snapshot).
  let revision = 0;
  // How many unanswered ops we allow ourselves right now: `window` normally, ONE after the server said
  // "too fast", then one more per answer. Sending the whole window into a budget that has refilled by
  // a single token got 49 refusals per accepted op (measured: 18,524 for 600 ops).
  let allowance = window;
  const answered = (): void => { allowance = Math.min(window, allowance + 1); };

  /**
   * Throw the guess away and make it again. Only the node MAP is copied; the nodes are shared.
   * That is safe because applyOpInto never edits a node: it puts a NEW node object in the map.
   * Measured on 5,000 nodes with 20 pending: about 1 ms per remote op, against 6.5 ms with structuredClone.
   */
  function rebuild(): void {
    revision++;
    optimistic = { ...confirmed, nodes: { ...confirmed.nodes } };
    for (const each of pending) applyOpInto(optimistic, each.op);
  }

  const wire = ({ opId, baseSeq, op }: Pending): ClientOp => ({ opId, baseSeq, op });

  function onWelcome(doc: Doc, welcomeSeq: number): Effects {
    // The contract checks each node's shape, not the tree. The server checks what it loads, but this
    // client trusts no one: a cycle in here would send the first move_node check round for ever.
    if (checkDoc(doc).length > 0) {
      ready = false;
      return { rejected: [], resync: false, fatal: "document_corrupt" };
    }
    confirmed = doc;
    seq = welcomeSeq;
    ready = true;
    // A new connection: nothing is on ITS wire yet, so everything pending goes out again (takeSendable).
    // Same opId: if the server did apply one of these before the connection dropped, it answers with
    // the original acknowledgement instead of applying it twice. Same baseSeq: it says what the op was
    // written against, and claiming something newer would switch the server's "stale" guard off.
    for (const each of pending) {
      each.maybeApplied ||= each.inFlight;
      each.inFlight = false;
    }
    rebuild();
    return { rejected: [], resync: false };
  }

  function onOp(message: Extract<ServerMessage, { type: "op" }>): Effects {
    const effects: Effects = { rejected: [], resync: false };
    if (message.seq > seq + 1) return { ...effects, resync: true }; // we missed something: touch nothing, start again from a welcome
    // Ours only if the id AND the content match. The room keys its memory by sender, so another peer
    // can submit a different op under an opId of ours that it saw in a broadcast; if we had not heard
    // that broadcast, the id alone would make us drop our edit and keep a guess nobody else has.
    // ponytail: content compared as JSON (the room echoes our op unchanged). E2.6 puts our own actor
    // in the welcome; comparing message.actor is the cleaner test then.
    const body = JSON.stringify(message.op);
    const mineAt = pending.findIndex((each) => each.opId === message.opId && JSON.stringify(each.op) === body);
    const wasHead = mineAt === 0;
    if (mineAt >= 0) {
      pending = pending.filter((_, i) => i !== mineAt);
      answered();
    }
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
    else if (mineAt < 0 && applyOpInto(optimistic, message.op)) revision++;
    return effects;
  }

  function onRejected({ opId, reason, retryAfterMs }: Extract<ServerMessage, { type: "rejected" }>): Effects {
    const effects: Effects = { rejected: [], resync: false };
    const mine = pending.find((each) => each.opId === opId);
    if (!mine) return effects;

    // Too fast. Nothing is wrong with the op: it and everything after it (the room refuses those too,
    // to keep the order) count as unsent again, and the transport waits before it sends anything.
    if (reason === RejectReason.enum.rate_limited) {
      for (const each of pending.slice(pending.indexOf(mine))) each.inFlight = false;
      allowance = 1;
      return { ...effects, pauseMs: Math.min(retryAfterMs ?? 1000, MAX_PAUSE_MS) };
    }

    // Not applied, and nothing wrong with the op: keep it and come back through a fresh welcome,
    // after a pause that GROWS (peer.ts), which resends everything pending.
    if (reason === RejectReason.enum.unavailable) return { ...effects, resync: true };

    if (reason === RejectReason.enum.stale) {
      // The room no longer remembers whether it applied this op. If the op would change nothing, it
      // is already there (or no longer makes sense): drop it quietly. If it WOULD change something,
      // that proves nothing: it may have been applied and then overwritten, and sending it again would
      // put an old write on top of a newer one, or bring back a node someone removed. So only an op
      // that no EARLIER connection ever carried is sent again; any other is given up and the user is told.
      // E6.1a's journal remembers every opId for good; from then on a resend is always safe.
      const alreadyThere = applyOp(confirmed, mine.op) === confirmed;
      if (!alreadyThere && !mine.maybeApplied && mine.staleCount < MAX_STALE_RETRIES) {
        mine.staleCount++;
        mine.baseSeq = seq; // honest again: it is now written against what we have seen
        // It goes out again, and so does everything after it: our own edits must reach the room in the
        // order we made them (red, then blue). The room answers the repeats from its memory.
        for (const each of pending.slice(pending.indexOf(mine))) each.inFlight = false;
        return effects;
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
    get pending(): readonly ClientOp[] { return pending.map(wire); },
    get pendingCount(): number { return pending.length; },
    get revision(): number { return revision; },

    /**
     * What the transport should write to the socket NOW: the oldest unsent ops, in order, as far as the
     * window allows. Calling this IS sending: never call it without writing the result to the wire.
     * The window is what keeps a peer that made 2,000 edits offline inside the room's rate limit: the
     * server's answers pace the client, with no timer and no guess at the server's budget.
     */
    takeSendable(): ClientOp[] {
      let room = allowance - pending.filter((each) => each.inFlight).length;
      const out: ClientOp[] = [];
      for (const each of pending) {
        if (room <= 0) break;
        if (each.inFlight) continue; // (whoever clears inFlight clears it for every LATER op too, so order holds)
        each.inFlight = true;
        out.push(wire(each));
        room--;
      }
      return out;
    },

    /** The peer has ended for good: forget what was never confirmed, and return it so the caller can say so. */
    abandon(): Rejection[] {
      const lost = pending.map(({ opId, op }): Rejection => ({ opId, op, reason: "connection_closed", quiet: false }));
      pending = [];
      if (lost.length > 0) rebuild();
      return lost;
    },

    /** An edit made here. Checked against what the user SEES, applied at once, returned ready to send. */
    local(op: Op): LocalResult {
      if (!ready) return { ok: false, reason: "not_ready" };
      if (pending.length >= maxPending) return { ok: false, reason: "too_many_pending" };
      const clientOp = ClientOp.safeParse({ opId: mintOpId(), baseSeq: seq, op });
      if (!clientOp.success) return { ok: false, reason: "invalid_op" }; // e.g. props over 32 KB: the server would drop the connection
      const verdict = validate(optimistic, op, manifest);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      // An edit that changes nothing (a drag that ended where it began) is not worth a message.
      if (!applyOpInto(optimistic, clientOp.data.op)) return { ok: true, opId: clientOp.data.opId };
      revision++;
      pending.push({ ...clientOp.data, staleCount: 0, inFlight: false, maybeApplied: false });
      return { ok: true, opId: clientOp.data.opId };
    },

    receive(message: DocMessage): Effects {
      switch (message.type) {
        case "welcome": return onWelcome(message.doc, message.seq);
        case "op": return onOp(message);
        case "rejected": return onRejected(message);
        case "ack": {
          // The server found the op changed nothing: the wait is over, and so is our guess about it.
          const mine = pending.find((each) => each.opId === message.opId);
          if (!mine) return { rejected: [], resync: false };
          // We can check: when the ack was sent, the server's document was exactly our confirmed one.
          // If the op WOULD change it, this ack is wrong; believing it would silently delete an edit.
          if (applyOp(confirmed, mine.op) !== confirmed) return { rejected: [], resync: true };
          pending = pending.filter((each) => each !== mine);
          answered();
          rebuild();
          return { rejected: [], resync: false };
        }
      }
    },
  };
}

