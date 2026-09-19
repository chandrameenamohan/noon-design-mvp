/**
 * The committed seeds (SPEC F8a). 1-40 are plain coverage. The NAMED ones are regression seeds: each
 * is the first seed that caught a deliberately broken rule (sim.test.ts keeps proving that it does).
 * A seed that ever fails in CI is added here with a name and stays for good.
 */
export const NAMED = {
  /** The room forgets who sent an op (dedupe without the sender): a resend after a reconnect is applied twice. */
  roomDedupeIgnoresSender: 18,
  /** A replica claims a fresh baseSeq on every resend: after a room reload an already applied op is applied again. */
  replicaLiesAboutBaseSeq: 7,
  /** A replica applies a LATE acknowledgement again (an op the welcome already contained), putting an old value over a newer one. */
  replicaAppliesLateAckAgain: 2,
  /** The same bug made in the SOURCE (replica.ts, `message.seq <= seq`): first caught here once the simulator learned to make colliding edits. */
  lateAckInSource: 53,
} as const;
export const SEEDS: readonly number[] = [...new Set([...Array.from({ length: 40 }, (_, i) => i + 1), ...Object.values(NAMED)])];
