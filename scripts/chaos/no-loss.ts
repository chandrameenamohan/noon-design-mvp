// F18's guarantees as one pure check, reused by every chaos run that breaks the sync server mid-edit:
// chaos:kill-sync-no-loss (E6.3) now, the failover run (E7.2) next. The run keeps a LEDGER of every op
// its peers submitted and when each settled; afterwards it reads the journal (the truth) and asks:
//   - every op acknowledged before the fault is journaled, at the seq it was acknowledged with;
//   - every op in flight at the fault (or made while the server was gone) was resent and applied once;
//   - no op is journaled twice, the journal's seqs are 1..n without a gap, nothing untracked is in it;
//   - every peer ends on the same confirmed document.
// Vacuity guards (SPEC §4a): a run with no op acknowledged before the fault, or none in flight at it,
// proved nothing, and says so.

/** An op's fate, as @noon/peer-client's submit().settled reports it. `seq` is missing for an op that changed nothing. */
type Outcome = { ok: true; seq?: number } | { ok: false; reason: string };
/** What submit() returned; a local refusal was never sent, so there is nothing to account for. */
type Submitted = { ok: true; opId: string; settled: Promise<Outcome> } | { ok: false };

/** One op a peer submitted. `atFault`: its fate when the fault struck; "after" for an op made after it. */
export type LedgerEntry = { peer: string; opId: string; atFault: Outcome | "unsettled" | "after"; outcome: Outcome | "unsettled" };
export type JournalRow = { seq: number; opId: string };

export function createLedger() {
  const entries: LedgerEntry[] = [];
  const settling: Promise<unknown>[] = [];
  let faulted = false;
  return {
    entries: entries as readonly LedgerEntry[],
    track(peer: string, submitted: Submitted): void {
      if (!submitted.ok) return;
      const entry: LedgerEntry = { peer, opId: submitted.opId, atFault: faulted ? "after" : "unsettled", outcome: "unsettled" };
      entries.push(entry);
      settling.push(submitted.settled.then((outcome) => { entry.outcome = outcome; }));
    },
    /** Call right after the fault is opened: what has settled by now counts as "before the fault". */
    fault(): void {
      faulted = true;
      for (const entry of entries) if (entry.atFault === "unsettled") entry.atFault = entry.outcome;
    },
    /** Wait for every op to settle, at most `timeoutMs`; whatever has not by then stays "unsettled" (lost). */
    async settle(timeoutMs: number): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(settling), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
      clearTimeout(timer);
    },
  };
}

/** Every broken guarantee, in words; empty = PASS. `docs`: each peer's confirmed document, serialized. */
export function noLossViolations({ ledger, journal, docs }: { ledger: readonly LedgerEntry[]; journal: readonly JournalRow[]; docs: readonly string[] }): string[] {
  const violations: string[] = [];
  if (!ledger.some((e) => typeof e.atFault === "object" && e.atFault.ok && e.atFault.seq !== undefined)) violations.push("vacuous: no op was acknowledged before the fault");
  if (!ledger.some((e) => e.atFault === "unsettled")) violations.push("vacuous: no op was in flight at the fault, so nothing was resent");

  const seqs = journal.map((row) => row.seq);
  if (seqs.some((seq, i) => seq !== i + 1)) violations.push(`the journal's seqs are ${seqs.join(",")}, not 1..${String(seqs.length)} without a gap or repeat`);
  const seqsOf = new Map<string, number[]>();
  for (const row of journal) seqsOf.set(row.opId, [...(seqsOf.get(row.opId) ?? []), row.seq]);
  for (const [opId, at] of seqsOf) if (at.length > 1) violations.push(`op ${opId} is journaled ${String(at.length)} times (seq ${at.join(", ")})`);
  const tracked = new Set(ledger.map((e) => e.opId));
  for (const row of journal) if (!tracked.has(row.opId)) violations.push(`journal seq ${String(row.seq)} holds op ${row.opId}, which no tracked peer submitted`);

  const bySeq = new Map(journal.map((row) => [row.seq, row.opId]));
  for (const e of ledger) {
    const refusedBefore = typeof e.atFault === "object" && !e.atFault.ok;
    const what = `${e.peer} op ${e.opId}${refusedBefore ? "" : e.atFault === "unsettled" ? " (in flight at the fault)" : e.atFault === "after" ? " (made after the fault)" : " (acknowledged before the fault)"}`;
    if (e.outcome === "unsettled") violations.push(`${what} never settled: lost`);
    else if (!e.outcome.ok) {
      if (!refusedBefore) violations.push(`${what} was refused (${e.outcome.reason}): lost`);
      else if (seqsOf.has(e.opId)) violations.push(`${what} was refused (${e.outcome.reason}) but is journaled`);
    } else if (e.outcome.seq !== undefined && bySeq.get(e.outcome.seq) !== e.opId) {
      violations.push(`${what} was acknowledged at seq ${String(e.outcome.seq)}, but the journal has ${bySeq.get(e.outcome.seq) ?? "nothing"} there`);
    }
  }

  docs.forEach((doc, i) => { if (doc !== docs[0]) violations.push(`peer ${String(i)}'s confirmed document differs from peer 0's`); });
  return violations;
}
