// The 23 properties of antithesis/scratchbook/property-catalog.md as the harness asserts them, and the report's
// judgement over what the SDK wrote. Pure: no SDK, no I/O (sdk.ts emits, report.ts reads files).
//
// The catalog puts thirteen assertion sites inside the SUT (`apps/sync/src/room.ts:226` and so on). Z.2b runs the
// UNCHANGED images (SPEC §4a: change configuration, never code), so every one of them is asserted here from what
// the SUT shows outside itself: its journal, its job rows, Redis, Gitea, what its peers are told, and its logs.
// README.md lists, per property, which observation stands in for which line.

/** SPEC §4a's assertion kinds, as the catalog's front matter spells them. */
type Kind = "always" | "sometimes" | "unreachable" | "eventually" | "reachability";
export type Property = { slug: string; kind: Kind; priority: "P0" | "P1" | "P2"; claim: string; guard?: string };

/** The fault windows of dangerous-windows-reached (R1..R7): one `reachable` each. */
export const WINDOWS = {
  R1: "the sync owner died with an op in flight",
  R2: "an owner frozen past its lease had an append reach Postgres after a newer owner's claim",
  R3: "Postgres was cut with a room open",
  R4: "a worker was killed mid-run, with some steps journaled",
  R5: "Redis was wiped with jobs waiting and running",
  R6: "two peers edited the same node concurrently",
  R7: "a worker paused past staleMs woke up",
} as const;
export type Window = keyof typeof WINDOWS;

// `guard` is the catalog's vacuity guard, word for word (properties.test.ts holds the two together).
export const PROPERTIES: readonly Property[] = [
  { slug: "peers-converge", kind: "always", priority: "P0", claim: "every peer's confirmed document equals a replay of the journal", guard: "the room applied an op whose sender had not yet seen the room's latest op" },
  { slug: "acknowledged-op-never-lost", kind: "always", priority: "P0", claim: "every op its sender saw acknowledged is in the journal at that seq", guard: "an op was in flight (sent, not yet acknowledged) when the fault struck" },
  { slug: "op-applied-at-most-once", kind: "always", priority: "P0", claim: "no op is journaled or applied twice", guard: "the room answered a resend from the journal with its original row" },
  { slug: "journal-seq-contiguous", kind: "always", priority: "P0", claim: "every document's journal seqs are 1..n with no gap and no repeat", guard: "a journal append failed while ops were flowing" },
  { slug: "document-always-a-tree", kind: "always", priority: "P0", claim: "after every journaled op the document is a tree", guard: "a move into the node's own subtree was refused as a cycle" },
  { slug: "no-cross-org-read", kind: "unreachable", priority: "P0", claim: "a stranger got a 2xx or a welcome", guard: "a stranger asked for another org's document and was answered 404" },
  { slug: "one-job-per-idempotency-key", kind: "always", priority: "P0", claim: "an idempotency key names one job", guard: "a repeated start was answered with the job its key had made" },
  { slug: "job-claimed-once-per-attempt", kind: "always", priority: "P0", claim: "a job is claimed once per attempt and each of its steps is journaled once", guard: "a duplicate or stale queue message found nothing to claim" },
  { slug: "one-open-pr-per-document", kind: "always", priority: "P0", claim: "a document's branch has at most one open pull request", guard: "ship found the branch's pull request already open (409) and reused it" },
  { slug: "zombie-owner-append-fenced", kind: "unreachable", priority: "P1", claim: "an append landed with a claim that is not the document's", guard: "a room's append was refused as Fenced and the room gave itself up" },
  { slug: "one-owner-per-room", kind: "always", priority: "P1", claim: "the lease token only rises and the journal's fence names the lease holder's token", guard: "a document's room moved to another sync node" },
  { slug: "storage-outage-visible-read-only", kind: "always", priority: "P1", claim: "a storage outage makes every peer read-only, acknowledges nothing, and the held op lands once", guard: "a room went read-only because its journal failed" },
  { slug: "room-recovers-after-owner-death", kind: "eventually", priority: "P1", claim: "every document a peer had open accepts an op again", guard: "the owner of a room with connected peers was killed" },
  { slug: "killed-worker-job-resumes", kind: "eventually", priority: "P1", claim: "every started job reaches a terminal status, and no retry begins before the heartbeat is stale", guard: "a worker was killed while its job was running" },
  { slug: "superseded-attempt-writes-nothing", kind: "always", priority: "P1", claim: "a write under a stale attempt changes nothing", guard: "a stalled attempt woke up after its job was given to another attempt" },
  { slug: "redis-loss-jobs-rebuilt", kind: "eventually", priority: "P1", claim: "every job waiting or running at a Redis wipe finishes, claimed once", guard: "jobs were waiting in Redis and running when it was wiped" },
  { slug: "no-edit-without-edit-role", kind: "unreachable", priority: "P1", claim: "an op was journaled for a peer that may not edit", guard: "an op from a peer without edit rights reached the room and was refused" },
  { slug: "revoked-share-loses-access", kind: "eventually", priority: "P1", claim: "a revoked share's session is closed and its holder cannot come back", guard: "a share was revoked while its holder had the document open" },
  { slug: "shipped-page-equals-codegen", kind: "always", priority: "P1", claim: "the file on the document's branch is the codegen of the document at a seq it had", guard: "a ship pushed a commit to the document's branch" },
  { slug: "dropped-webhook-push-reaches-canvas", kind: "eventually", priority: "P1", claim: "every engineer's push is in its document's journal once, and shows on the open canvas within the reconcile period", guard: "a push whose webhook delivery was dropped was recorded by the reconcile" },
  { slug: "dangerous-windows-reached", kind: "reachability", priority: "P1", claim: "the run entered every fault window R1..R7" },
  { slug: "failed-ai-run-leaves-document-valid", kind: "always", priority: "P2", claim: "a run that did not succeed has a reason, journals nothing after its end, and its applied ops stay", guard: "an AI run ended cancelled, failed or timed out with ops already applied" },
  { slug: "ai-and-person-edit-together", kind: "sometimes", priority: "P2", claim: "an agent op and a user op were accepted back to back" },
];

const known = new Map(PROPERTIES.map((property) => [property.slug, property]));
export const propertyOf = (slug: string): Property => {
  const found = known.get(slug);
  if (!found) throw new Error(`no such property in the catalog: ${slug}`);
  return found;
};

// What the SDK is told. The slug leads, so a line of SDK output can be traced to the catalog without a table.
export const claimMessage = (slug: string): string => `${slug}: ${propertyOf(slug).claim}`;
export const guardMessage = (slug: string): string => `${slug} [guard]: ${propertyOf(slug).guard ?? ""}`;
export const windowMessage = (window: Window): string => `dangerous-windows-reached [${window}]: ${WINDOWS[window]}`;

/** One `antithesis_assert` line of SDK local output, as far as the report reads it. */
export type AssertRecord = { message: string; hit: boolean; condition: boolean };

/** The SDK's local output is one JSON object per line; anything else in the file (a lifecycle event) is skipped. */
export function parseSdkOutput(text: string): AssertRecord[] {
  const records: AssertRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a process killed mid-write leaves half a line: the lines before it still count
    }
    const assert = typeof parsed === "object" && parsed !== null && "antithesis_assert" in parsed ? parsed.antithesis_assert : undefined;
    if (typeof assert !== "object" || assert === null) continue;
    const { message, hit, condition } = assert as Record<string, unknown>;
    if (typeof message === "string" && typeof hit === "boolean" && typeof condition === "boolean") records.push({ message, hit, condition });
  }
  return records;
}

type Verdict = "PASS" | "FAIL" | "NOT RUN";
export type Row = { slug: string; kind: Kind; priority: string; verdict: Verdict; passes: number; fails: number; guard: "hit" | "MISSED" | "-"; note: string };

/**
 * PASS/FAIL per property, by the SDK's own rules: an `always` (and an `eventually`, which is an always asserted
 * after the faults stop) fails on one false and is NOT RUN when it was never evaluated (never a PASS: SPEC §4a,
 * "verify the harness's own properties first"); an `unreachable` fails on one hit; a `sometimes` and each
 * reachability window need one true. A guard is hit by one true.
 */
export function judge(records: readonly AssertRecord[]): Row[] {
  const count = (message: string): { passes: number; fails: number } => {
    const mine = records.filter((record) => record.hit && record.message === message);
    return { passes: mine.filter((record) => record.condition).length, fails: mine.filter((record) => !record.condition).length };
  };
  return PROPERTIES.map((property): Row => {
    const { slug, kind, priority } = property;
    const guard = property.guard === undefined ? "-" : count(guardMessage(slug)).passes > 0 ? "hit" : "MISSED";
    const row = (verdict: Verdict, passes: number, fails: number, note = ""): Row => ({ slug, kind, priority, verdict, passes, fails, guard, note });
    if (kind === "reachability") {
      const missed = (Object.keys(WINDOWS) as Window[]).filter((window) => count(windowMessage(window)).passes === 0);
      return row(missed.length === 0 ? "PASS" : "FAIL", Object.keys(WINDOWS).length - missed.length, missed.length, missed.length === 0 ? "" : `not reached: ${missed.join(" ")}`);
    }
    const { passes, fails } = count(claimMessage(slug));
    // An unreachable is emitted only when it happens, so its hits are all failures, whatever `condition` says.
    if (kind === "unreachable") return row(passes + fails > 0 ? "FAIL" : "PASS", 0, passes + fails);
    if (kind === "sometimes") return row(passes > 0 ? "PASS" : "FAIL", passes, fails, passes > 0 ? "" : "never true");
    return row(fails > 0 ? "FAIL" : passes > 0 ? "PASS" : "NOT RUN", passes, fails);
  });
}

export function table(rows: readonly Row[]): string {
  const lines = [`${"property".padEnd(38)}${"type".padEnd(14)}${"pri".padEnd(5)}${"result".padEnd(9)}${"pass".padEnd(6)}${"fail".padEnd(6)}guard`];
  for (const row of rows) lines.push(`${row.slug.padEnd(38)}${row.kind.padEnd(14)}${row.priority.padEnd(5)}${row.verdict.padEnd(9)}${String(row.passes).padEnd(6)}${String(row.fails).padEnd(6)}${row.guard}${row.note === "" ? "" : `  (${row.note})`}`);
  const guarded = rows.filter((row) => row.guard !== "-");
  lines.push(`${String(rows.filter((row) => row.verdict === "PASS").length)}/${String(rows.length)} properties PASS, ${String(guarded.filter((row) => row.guard === "hit").length)}/${String(guarded.length)} vacuity guards hit`);
  return lines.join("\n");
}

/** The two named checks: harness:baseline-all-pass and harness:vacuity-guards-hit. Empty = the check holds. */
export const notPassing = (rows: readonly Row[]): string[] => rows.filter((row) => row.verdict !== "PASS").map((row) => `${row.slug}: ${row.verdict}${row.note === "" ? "" : ` (${row.note})`}`);
export const guardsMissed = (rows: readonly Row[]): string[] => rows.filter((row) => row.guard === "MISSED").map((row) => `${row.slug}: its guard never fired`);
