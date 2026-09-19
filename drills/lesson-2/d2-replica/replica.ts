// DRILL 2 · one bug from Lesson 2 is planted in this file. Find it and fix it HERE.
//
// A replica, cut down to one kind of edit: "set key to value" on a flat document. The ideas are the
// real ones (packages/peer-client/src/replica.ts): `confirmed` is what the server said, in its order;
// `pending` are our own edits it has not answered; what the user sees is confirmed + pending.

export type SetOp = { key: string; value: number };
export type ServerMessage =
  | { type: "welcome"; doc: Record<string, number>; seq: number }
  | { type: "op"; seq: number; opId: string; op: SetOp };

export function createReplica() {
  let confirmed: Record<string, number> = {};
  let seq = 0;
  let pending: { opId: string; op: SetOp }[] = [];
  let nextId = 0;

  return {
    /** What the user sees: the server's document, then our unanswered edits on top, in order. */
    get doc(): Record<string, number> {
      const guess = { ...confirmed };
      for (const each of pending) guess[each.op.key] = each.op.value;
      return guess;
    },
    get pendingCount(): number { return pending.length; },

    /** An edit made here: shown at once, returned ready to send. */
    local(op: SetOp): { opId: string; op: SetOp } {
      const made = { opId: `op-${String(++nextId)}`, op };
      pending.push(made);
      return made;
    },

    /** After a reconnect: everything unanswered goes out again, with the SAME ids. */
    resend(): { opId: string; op: SetOp }[] { return [...pending]; },

    receive(message: ServerMessage): void {
      if (message.type === "welcome") {
        confirmed = { ...message.doc };
        seq = message.seq;
        return;
      }
      // Ours? Then the wait for it is over.
      pending = pending.filter((each) => each.opId !== message.opId);
      confirmed[message.op.key] = message.op.value;
      seq = Math.max(seq, message.seq);
    },
  };
}
