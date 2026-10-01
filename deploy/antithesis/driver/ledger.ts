// The op ledger (SPEC §4a A1): every op a driver peer submitted, what had become of it when the fault struck, and
// how it settled, written to the run's state so that `finally_ledger`, a later process, can hold all of it against
// the journal. The bookkeeping and the judgement are scripts/chaos/no-loss.ts's, called and not rewritten; this file
// adds what a ledger kept ACROSS processes needs (a file per document and process) and the pure checks the catalog
// asks for beyond no-loss: the tree after every op, which ops met concurrency, which resends the journal answered.
import { createHash } from "node:crypto";
import type { Doc, Op } from "@noon/contracts";
import { applyOpInto, checkDoc, emptyDoc } from "@noon/doc-model";
import { createLedger, noLossViolations, type JournalRow as LossRow, type LedgerEntry } from "../../../scripts/chaos/no-loss.ts";
import type { DriverPeer, Epoch, Holder } from "./world.ts";

/** What the ledger knows of one op beyond its fate: what its sender had seen, and over which connection it was answered. */
type Note = { op: Op; seqAtSubmit: number; ahead: number; epochAtSubmit: number; epochAtSettle?: number; peer: string };
/** One process's ledger of one document, as it lies in `ledger/`. */
export type LedgerFile = {
  document: string; scene: string;
  entries: LedgerEntry[];
  notes: Record<string, Note>;
  epochs: Record<string, Epoch[]>;
  /** Each editing peer's confirmed document when it stopped: its seq, and the document's hash. */
  finals: { peer: string; seq: number; hash: string }[];
  /** The fault this scene's ops met, if any (a quiet driver has none). */
  fault?: string;
  /** User ids that may only watch this document: none of their ops may be journaled. */
  viewers: string[];
  /** The room's owner around the fault, and the journal's fence afterwards (one-owner-per-room). */
  lease?: { before: Holder; after: Holder | undefined; fenceToken: number; moveMs: number };
  /** What the scene itself observed (the windows it entered, what it measured). */
  facts: Record<string, unknown>;
};

/** A journal row, as the judge reads it from Postgres. */
export type JournalRow = { seq: number; opId: string; actorKind: string; actorId: string; runId: string | null; op: Op; createdAt: number };

/** Key order must not matter: a peer and a replay build the same nodes in different orders. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const hashOf = (doc: Doc): string => createHash("sha256").update(canonical(doc)).digest("hex");

/** A live ledger: no-loss.ts's, plus the notes, and `file()` to keep it. */
export function openLedger(document: string, scene: string) {
  const base = createLedger();
  const notes: Record<string, Note> = {};
  const peers = new Map<string, DriverPeer>();
  let fault: string | undefined;
  return {
    entries: base.entries,
    /** Submits `op` as `name` and tracks it. A local refusal was never sent: nothing to account for. */
    submit(name: string, peer: DriverPeer, op: Op): ReturnType<DriverPeer["submit"]> {
      peers.set(name, peer);
      const [seqAtSubmit, ahead, epochAtSubmit] = [peer.seq, peer.pendingCount, peer.epochs.length];
      const submitted = peer.submit(op);
      base.track(name, submitted);
      if (submitted.ok) {
        const note: Note = { op, seqAtSubmit, ahead, epochAtSubmit, peer: name };
        notes[submitted.opId] = note;
        void submitted.settled.then(() => { note.epochAtSettle = peer.epochs.length; });
      }
      return submitted;
    },
    /** Right after the fault is opened: what has settled by now counts as "before the fault". */
    fault(kind: string): void {
      fault = kind;
      base.fault();
    },
    settle: (timeoutMs: number): Promise<void> => base.settle(timeoutMs),
    file(extra: Partial<Pick<LedgerFile, "viewers" | "lease" | "facts">> = {}): LedgerFile {
      // A quiet driver's ops all settled "before the fault" there never was: no-loss then holds a refusal to its reason.
      if (fault === undefined) base.fault();
      return {
        document, scene, entries: [...base.entries], notes,
        epochs: Object.fromEntries([...peers].map(([name, peer]) => [name, peer.epochs])),
        finals: [...peers].filter(([, peer]) => peer.status === "live").map(([name, peer]) => ({ peer: name, seq: peer.seq, hash: hashOf(peer.confirmed) })),
        ...(fault === undefined ? {} : { fault }),
        viewers: extra.viewers ?? [], ...(extra.lease ? { lease: extra.lease } : {}), facts: extra.facts ?? {},
      };
    },
  };
}

/** The journal replayed from nothing: the document's hash after every seq, and every seq at which it was not a tree. */
export function replay(journal: readonly JournalRow[]): { hashes: Map<number, string>; broken: { seq: number; problems: string[] }[]; doc: Doc } {
  const doc = emptyDoc();
  const hashes = new Map<number, string>([[0, hashOf(doc)]]);
  const broken: { seq: number; problems: string[] }[] = [];
  for (const row of journal) {
    applyOpInto(doc, row.op);
    const problems = checkDoc(doc);
    if (problems.length > 0) broken.push({ seq: row.seq, problems });
    hashes.set(row.seq, hashOf(doc));
  }
  return { hashes, broken, doc };
}

/**
 * What no-loss.ts finds wrong with one document, over every process's ledger of it. Its two "vacuous" lines are
 * left out: here they are guards (`inFlightAtFault`), not failures. Rows an AI run journaled are placed as their
 * run's (finally_jobs counts them against its steps) and the git peer's as their push's (eventually_push_on_canvas
 * counts them against the commit); every other row must be an op some driver peer submitted.
 */
export function lossViolations(files: readonly LedgerFile[], journal: readonly JournalRow[]): string[] {
  const entries = files.flatMap((file) => file.entries);
  const agents = journal.filter((row) => row.actorKind !== "user").map((row): LedgerEntry => ({ peer: `${row.actorKind === "git" ? "push" : "run"} ${row.runId ?? "?"}`, opId: row.opId, atFault: { ok: true, seq: row.seq }, outcome: { ok: true, seq: row.seq } }));
  const rows: LossRow[] = journal.map(({ seq, opId }) => ({ seq, opId }));
  return noLossViolations({ ledger: [...entries, ...agents], journal: rows, docs: [] }).filter((violation) => !violation.startsWith("vacuous:"));
}

/** Ops that were sent and not yet answered when a fault struck (R1, and acknowledged-op-never-lost's guard). */
export const inFlightAtFault = (file: LedgerFile): LedgerEntry[] => (file.fault === undefined ? [] : file.entries.filter((entry) => entry.atFault === "unsettled"));

/**
 * Ops the room ordered behind something their sender had not seen: acknowledged at a seq further on than the
 * sender's own queue explains (peers-converge's guard). `sameNode`: only those where the op in between touched
 * the same node (R6).
 */
export function concurrent(file: LedgerFile, journal: readonly JournalRow[], sameNode = false): string[] {
  const bySeq = new Map(journal.map((row) => [row.seq, row]));
  const nodeOf = (op: Op): string => op.nodeId;
  return file.entries.flatMap((entry) => {
    const note = file.notes[entry.opId];
    if (!note || typeof entry.outcome !== "object" || !entry.outcome.ok || entry.outcome.seq === undefined) return [];
    const { seq } = entry.outcome;
    if (seq <= note.seqAtSubmit + note.ahead + 1) return [];
    if (!sameNode) return [entry.opId];
    for (let between = note.seqAtSubmit + 1; between < seq; between++) {
      const row = bySeq.get(between);
      if (row && row.opId !== entry.opId && row.actorId !== bySeq.get(seq)?.actorId && nodeOf(row.op) === nodeOf(note.op)) return [entry.opId];
    }
    return [];
  });
}

/**
 * Ops answered from the JOURNAL with their original row (op-applied-at-most-once's guard): acknowledged over a
 * later connection than the one they were first sent on (so they were resent), to a room opened under another
 * lease token (so its memory held nothing), at the seq of a row journaled before that connection existed.
 */
export function answeredFromJournal(file: LedgerFile, journal: readonly JournalRow[]): string[] {
  const bySeq = new Map(journal.map((row) => [row.seq, row]));
  return file.entries.flatMap((entry) => {
    const note = file.notes[entry.opId];
    if (!note || note.epochAtSettle === undefined || note.epochAtSettle <= note.epochAtSubmit) return [];
    if (typeof entry.outcome !== "object" || !entry.outcome.ok || entry.outcome.seq === undefined) return [];
    const epochs = file.epochs[note.peer] ?? [];
    const [sentOn, answeredOn] = [epochs[note.epochAtSubmit - 1], epochs[note.epochAtSettle - 1]];
    const row = bySeq.get(entry.outcome.seq);
    if (!sentOn || !answeredOn || row?.opId !== entry.opId) return [];
    return sentOn.token !== undefined && answeredOn.token !== undefined && answeredOn.token !== sentOn.token && row.createdAt < answeredOn.liveAt ? [entry.opId] : [];
  });
}
