// What chaos:redis-wipe-rebuild (E9.2b, SPEC §4 "Redis lost") judges, as pure checks: Redis is wiped while AI runs
// are running and others are waiting in it, and while a room is open. Postgres is the truth, so afterwards:
//   - every run succeeded, claimed ONCE (a wipe must not start a job twice), each of its steps journaled once, the
//     document's seqs 1..n without a gap;
//   - the room has one owner again: a lease with a token above the one before the wipe, and the journal's fence
//     (Postgres) naming that same token, so no second node holds a claim it could still write under.
// Vacuity guards (SPEC §4a): no job waiting in Redis at the wipe, or none running, proved nothing, and says so.

/** One run after the wipe: its row, and its document's journal counted (its own ops, and the room's seqs). */
export type RunAfter = { id: string; status: string; attempts: number; ops: number; opIds: number; nodes: number; seqs: number; maxSeq: number };
export type Holder = { token: number; node: string };

export function runViolations({ steps, runs, waitingAtWipe, runningAtWipe }: { steps: ReadonlyMap<string, number>; runs: readonly RunAfter[]; waitingAtWipe: number; runningAtWipe: number }): string[] {
  const violations: string[] = [];
  if (waitingAtWipe === 0) violations.push("vacuous: no job was waiting in Redis at the wipe, so no queue had to be rebuilt");
  if (runningAtWipe === 0) violations.push("vacuous: no job was running at the wipe");
  for (const [id, want] of steps) {
    const run = runs.find((r) => r.id === id);
    if (!run) {
      violations.push(`run ${id} has no row`);
      continue;
    }
    if (run.status !== "succeeded") violations.push(`run ${id} ended ${run.status}, not succeeded`);
    if (run.attempts !== 1) violations.push(`run ${id} was claimed ${String(run.attempts)} times: the wipe started it again`);
    if (run.ops !== want || run.opIds !== want || run.nodes !== want) violations.push(`run ${id} journaled ops=${String(run.ops)} opIds=${String(run.opIds)} nodes=${String(run.nodes)}, not ${String(want)} of each`);
    if (run.seqs !== run.maxSeq) violations.push(`run ${id}'s document has ${String(run.seqs)} distinct seqs up to ${String(run.maxSeq)}: a gap or a repeat`);
  }
  return violations;
}

export function leaseViolations({ before, after, fenceToken }: { before: Holder; after: Holder | undefined; fenceToken: number }): string[] {
  if (!after) return ["nobody holds the room's lease after the wipe"];
  const violations: string[] = [];
  if (after.token <= before.token) violations.push(`the lease's token went from ${String(before.token)} to ${String(after.token)}: a flushed counter issued a token again`);
  if (fenceToken !== after.token) violations.push(`the journal's fence is at token ${String(fenceToken)} but the lease is ${String(after.token)}:${after.node}: two owners`);
  return violations;
}
