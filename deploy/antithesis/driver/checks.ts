// The checks: what the test template's `anytime_`, `eventually_` and `finally_` commands assert. Each reads the
// SUT from outside (the journal, the job rows, Redis, Gitea, a peer of its own) and the run's state the workload
// left, and turns what it finds into SDK assertions keyed by the catalog's slugs (properties.ts).
import { randomUUID } from "node:crypto";
import { generate } from "@noon/codegen";
import type { Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOpInto, emptyDoc } from "@noon/doc-model";
import { connectPeer } from "@noon/peer-client";
import { leaseViolations, runViolations, type RunAfter } from "../../../scripts/chaos/rebuild.ts";
import { answeredFromJournal, concurrent, inFlightAtFault, lossViolations, openLedger, replay, type JournalRow, type LedgerFile } from "./ledger.ts";
import { landed, staleAppends, statements } from "./pglog.ts";
import type { Window } from "./properties.ts";
import { claim, guard, happened, reached } from "./sdk.ts";
import { call, config, holderOf, peerOf, redis, say, sleep, sql, state, until, world } from "./world.ts";
import { jobRow, keep, stack, type JobNote, type Revoke } from "./workload.ts";

const journalOf = async (document: string): Promise<JournalRow[]> =>
  (await sql<{ seq: string; op_id: string; actor_kind: string; actor_id: string; run_id: string | null; op: Op; at: string }>(
    "select seq, op_id, actor_kind, actor_id, run_id, op, (extract(epoch from created_at) * 1000)::bigint as at from op_journal where document_id = $1 order by seq", [document],
  )).map((row) => ({ seq: Number(row.seq), opId: row.op_id, actorKind: row.actor_kind, actorId: row.actor_id, runId: row.run_id, op: row.op, createdAt: Number(row.at) }));

/** The run's ledgers, per document: several processes may each have kept one of the same document. */
function ledgers(): Map<string, LedgerFile[]> {
  const byDocument = new Map<string, LedgerFile[]>();
  for (const file of state.all<LedgerFile>("ledger")) byDocument.set(file.document, [...(byDocument.get(file.document) ?? []), file]);
  return byDocument;
}
const jobs = (): JobNote[] => state.lines<JobNote>("jobs.jsonl");
/** A window a scene saw itself enter: kept, so that finally_windows_reached can say so. */
export const sawWindow = (window: Window, details: Record<string, unknown> = {}): void => { state.append("facts.jsonl", { window, ...details }); };

// --- anytime_stranger_probe (no-cross-org-read) ---------------------------------------------------------------------
/** Someone from another org asks for this org's real things, by id, over REST and over the socket. */
export async function strangerProbe(): Promise<void> {
  const { org, workspace, stranger, strangerDoc } = world();
  const documents = (await sql<{ id: string }>("select id from documents where org_id = $1 order by created_at desc limit 3", [org])).map((row) => row.id);
  const runs = (await sql<{ id: string; document_id: string }>("select id, document_id from jobs where org_id = $1 and queue = 'ai' order by created_at desc limit 1", [org]));
  const asks: [string, string, unknown?][] = [
    ["GET", `/orgs/${org}`], ["GET", `/orgs/${org}/members`], ["GET", `/orgs/${org}/workspaces`], ["GET", `/orgs/${org}/workspaces/${workspace}`],
    ["GET", `/orgs/${org}/workspaces/${workspace}/documents`], ["GET", `/orgs/${org}/usage`], ["GET", `/orgs/${org}/audit`],
    ["POST", `/orgs/${org}/workspaces/${workspace}/documents`, { title: "a stranger's" }], ["PUT", `/orgs/${org}/members`, { email: stranger, role: "owner" }],
    ...documents.flatMap((id): [string, string, unknown?][] => [
      ["GET", `/orgs/${org}/documents/${id}`], ["POST", `/documents/${id}/session`], ["GET", `/documents/${id}/run`], ["GET", `/documents/${id}/ship`],
      ["GET", `/documents/${id}/shares`], ["GET", `/documents/${id}/conflict`], ["GET", `/documents/${id}/preview`],
      ["POST", `/documents/${id}/runs`, { instruction: "nodes=1" }], ["POST", `/documents/${id}/ship`], ["PUT", `/documents/${id}/shares`, { email: stranger, role: "editor" }],
    ]),
    ...runs.flatMap((run): [string, string, unknown?][] => [["GET", `/documents/${run.document_id}/runs/${run.id}`], ["POST", `/documents/${run.document_id}/runs/${run.id}/cancel`]]),
  ];
  let refused = 0;
  for (const [method, path, body] of asks) {
    const answer = await call(stranger, method, path, body);
    if (answer.status >= 200 && answer.status <= 299) happened("no-cross-org-read", { method, path, status: answer.status });
    else if (answer.status === 404) refused++;
  }
  // The socket: the stranger's own, valid token (for their own document), presented at this org's document.
  for (const target of documents.slice(0, 1)) {
    const own = await call(stranger, "POST", `/documents/${strangerDoc}/session`);
    const session = own.status === 200 ? (own.body as { wsUrl: string; token: string }) : undefined;
    if (!session) continue; // the api is away (a fault): nothing was leaked, and nothing was probed
    let asked = false;
    const peer = connectPeer({ manifest, session: () => Promise.resolve(asked ? null : ((asked = true), { wsUrl: session.wsUrl.replace(strangerDoc, target), token: session.token })) });
    const welcomed = await until(() => peer.status === "live", 2000);
    if (welcomed) happened("no-cross-org-read", { socket: target, nodes: Object.keys(peer.confirmed.nodes).length });
    peer.close();
  }
  guard("no-cross-org-read", documents.length > 0 && refused > 0, { documents: documents.length, refused });
  say(`[stranger_probe] ${String(asks.length)} asks about ${String(documents.length)} real documents, ${String(refused)} answered 404`);
}

// --- anytime_journal_contiguous (journal-seq-contiguous) -------------------------------------------------------------
export async function journalContiguous(): Promise<void> {
  const bad = await sql("select document_id, count(*)::int as rows, count(distinct seq)::int as seqs, min(seq)::int as low, max(seq)::int as high from op_journal group by document_id having count(*) <> max(seq) or min(seq) <> 1 or count(distinct seq) <> count(*)");
  const documents = (await sql<{ documents: number }>("select count(distinct document_id)::int as documents from op_journal"))[0]?.documents ?? 0;
  claim("journal-seq-contiguous", bad.length === 0, { documents, bad: bad.slice(0, 5) });
  say(`[journal_contiguous] ${String(documents)} documents, ${String(bad.length)} with a gap or a repeat`);
}

// --- anytime_lease_matches_fence (one-owner-per-room) ---------------------------------------------------------------
/** Every held lease: its token is the journal's fence (after a moment: a room claims right after it takes the lease), and never below one seen before. */
export async function leaseMatchesFence(): Promise<void> {
  const seen = (state.read("tokens.json") ?? {}) as Record<string, number>;
  const keys = await redis().keys("lease:????????-????-????-????-????????????");
  const wrong: Record<string, unknown>[] = [];
  for (const key of keys) {
    const document = key.slice("lease:".length);
    const fence = async (): Promise<number | undefined> => Number((await sql<{ fence_token: string }>("select fence_token from documents where id = $1", [document]))[0]?.fence_token ?? NaN);
    let holder = await holderOf(document);
    // Agreement may take the length of a claim; a lease that changes hands meanwhile is simply read again.
    const agreed = await until(async () => {
      holder = await holderOf(document);
      return holder === undefined || holder.token === (await fence());
    }, 3000, 200);
    if (!agreed) wrong.push({ document, lease: holder, fence: await fence() });
    if (holder && holder.token < (seen[document] ?? 0)) wrong.push({ document, lease: holder, sawBefore: seen[document] });
    if (holder) seen[document] = Math.max(seen[document] ?? 0, holder.token);
  }
  state.write("tokens.json", seen);
  claim("one-owner-per-room", wrong.length === 0, { leases: keys.length, wrong });
  say(`[lease_matches_fence] ${String(keys.length)} leases, ${String(wrong.length)} wrong`);
}

// --- eventually_room_writable (room-recovers-after-owner-death) -----------------------------------------------------
/** After the faults: every document a driver peer had open takes an op again. The probe's op goes into the ledger too. */
export async function roomWritable(): Promise<void> {
  const { owner } = world();
  const budget = config.leaseTtlMs * 2 + 20_000;
  const documents = [...ledgers().keys()];
  for (const document of documents) {
    const ledger = openLedger(document, "probe");
    const peer = peerOf(owner, document);
    try {
      const joined = await until(() => peer.status === "live" && !peer.readOnly, budget);
      const probe = joined ? ledger.submit("probe", peer, stack(`probe-${randomUUID().slice(0, 8)}`)) : undefined;
      const outcome = probe?.ok ? await Promise.race([probe.settled, sleep(budget).then(() => undefined)]) : undefined;
      claim("room-recovers-after-owner-death", outcome?.ok === true, { document, joined, outcome: outcome ?? null });
      if (!outcome?.ok) say(`[room_writable] ${document}: NOT writable (joined ${String(joined)}, outcome ${JSON.stringify(outcome)})`);
      keep(ledger.file());
    } finally {
      peer.close();
    }
  }
  say(`[room_writable] ${String(documents.length)} documents probed`);
}

// --- eventually_jobs_settle (killed-worker-job-resumes, redis-loss-jobs-rebuilt) -------------------------------------
/** After the faults: every job a driver started ends; none was retried before its heartbeat was stale; the wiped ones all succeed. */
export async function jobsSettle(): Promise<void> {
  const all = jobs();
  // A killed worker's message comes back when BullMQ's stall check moves it (30 s), after the sweep requeued its row.
  const budget = config.staleMs + 90_000;
  const stuck: string[] = [];
  const early: Record<string, unknown>[] = [];
  const wiped: Record<string, unknown>[] = [];
  for (const job of all) {
    const terminal = await until(async () => ["succeeded", "failed", "cancelled"].includes((await jobRow(job.id))?.status ?? ""), budget, 200);
    const row = await jobRow(job.id);
    if (!terminal) stuck.push(`${job.kind} ${job.id} is ${row?.status ?? "gone"}`);
    if (job.heartbeatAtKill !== undefined && row && row.started - job.heartbeatAtKill < config.staleMs) early.push({ job: job.id, retriedAfterMs: row.started - job.heartbeatAtKill, staleMs: config.staleMs });
    if (job.wiped && row?.status !== "succeeded") wiped.push({ job: job.id, status: row?.status ?? "gone" });
  }
  claim("killed-worker-job-resumes", stuck.length === 0 && early.length === 0, { jobs: all.length, stuck, early });
  if (all.some((job) => job.wiped)) claim("redis-loss-jobs-rebuilt", wiped.length === 0, { wiped });
  say(`[jobs_settle] ${String(all.length)} jobs, ${String(stuck.length)} stuck, ${String(early.length)} retried early`);
}

// --- eventually_revoked_share_closed (revoked-share-loses-access) ---------------------------------------------------
/** After a revoke: the outsider cannot come back, by REST or by socket. (The open session closing is asserted where it was open.) */
export async function revokedShareClosed(): Promise<void> {
  for (const revoke of state.lines<Revoke>("revokes.jsonl")) {
    const answers = await Promise.all([call(revoke.outsider, "POST", `/documents/${revoke.document}/session`), call(revoke.outsider, "GET", `/documents/${revoke.document}/run`)]);
    const peer = peerOf(revoke.outsider, revoke.document);
    const back = await until(() => peer.status === "live", 2000);
    peer.close();
    claim("revoked-share-loses-access", answers.every((answer) => answer.status === 404) && !back, { document: revoke.document, statuses: answers.map((answer) => answer.status), back, what: "the outsider cannot come back" });
    say(`[revoked_share_closed] ${revoke.document}: ${answers.map((answer) => String(answer.status)).join(",")} back=${String(back)}`);
  }
}

// --- finally_ledger -------------------------------------------------------------------------------------------------
/** Every submitted op against the journal (scripts/chaos/no-loss.ts), and what the ledgers say about access and ownership. */
export async function finallyLedger(): Promise<void> {
  const all = ledgers();
  let [inFlight, resent, forbidden, cycles, backToBack, moved] = [0, 0, 0, 0, 0, 0];
  for (const [document, files] of all) {
    const journal = await journalOf(document);
    const violations = lossViolations(files, journal);
    const of = (pattern: RegExp): string[] => violations.filter((violation) => pattern.test(violation));
    // no-loss.ts's findings, each under the property it breaks.
    const lost = of(/never settled: lost|\): lost$|was acknowledged at seq/u);
    const twice = of(/is journaled \d+ times|which no tracked peer submitted|but is journaled/u);
    const gaps = of(/the journal's seqs are/u);
    claim("acknowledged-op-never-lost", lost.length === 0, { document, lost: lost.slice(0, 5) });
    claim("op-applied-at-most-once", twice.length === 0, { document, twice: twice.slice(0, 5) });
    claim("journal-seq-contiguous", gaps.length === 0, { document, gaps });
    const unplaced = violations.filter((violation) => ![...lost, ...twice, ...gaps].includes(violation));
    if (unplaced.length > 0) throw new Error(`no-loss.ts reported something this check does not place under a property: ${unplaced.join("; ")}`);

    for (const file of files) {
      inFlight += inFlightAtFault(file).length;
      resent += answeredFromJournal(file, journal).length;
      const reasons = file.entries.flatMap((entry) => (typeof entry.outcome === "object" && !entry.outcome.ok ? [entry.outcome.reason] : []));
      forbidden += reasons.filter((reason) => reason === "forbidden").length;
      cycles += reasons.filter((reason) => reason === "cycle").length;
      // F24: nothing a viewer sent may be in the journal.
      for (const row of journal) if (file.viewers.includes(row.actorId)) happened("no-edit-without-edit-role", { document, seq: row.seq, actor: row.actorId });
      if (file.lease) {
        const wrong = leaseViolations({ before: file.lease.before, after: file.lease.after, fenceToken: file.lease.fenceToken });
        claim("one-owner-per-room", wrong.length === 0, { document, scene: file.scene, wrong, lease: file.lease });
        if (file.lease.after && file.lease.after.node !== file.lease.before.node) moved++;
      }
      if (file.fault === "sync-killed" && inFlightAtFault(file).length > 0) reached("R1", { document, inFlight: inFlightAtFault(file).length });
    }
    for (let i = 1; i < journal.length; i++) {
      const pair = [journal[i - 1]?.actorKind, journal[i]?.actorKind];
      if (pair.includes("agent") && pair.includes("user")) backToBack++;
    }
  }
  guard("acknowledged-op-never-lost", inFlight > 0, { inFlight });
  guard("op-applied-at-most-once", resent > 0, { resent });
  guard("no-edit-without-edit-role", forbidden > 0, { forbidden });
  guard("document-always-a-tree", cycles > 0, { cycles });
  guard("one-owner-per-room", moved > 0, { moved });
  claim("ai-and-person-edit-together", backToBack > 0, { backToBack });
  say(`[finally_ledger] ${String(all.size)} documents: in flight at a fault ${String(inFlight)}, answered from the journal ${String(resent)}, forbidden ${String(forbidden)}, cycles refused ${String(cycles)}, rooms moved ${String(moved)}, agent/user back to back ${String(backToBack)}`);
}

// --- finally_peers_converge -----------------------------------------------------------------------------------------
/** Every peer's confirmed document is the journal's replay at that seq; and the replay is a tree after every op. */
export async function finallyPeersConverge(): Promise<void> {
  const { org } = world();
  const all = ledgers();
  let [met, sameNode, peers] = [0, 0, 0];
  const documents = (await sql<{ id: string }>("select distinct document_id as id from op_journal where org_id = $1", [org])).map((row) => row.id);
  for (const document of documents) {
    const journal = await journalOf(document);
    const { hashes, broken } = replay(journal);
    claim("document-always-a-tree", broken.length === 0, { document, ops: journal.length, broken: broken.slice(0, 3) });
    for (const file of all.get(document) ?? []) {
      for (const final of file.finals) {
        peers++;
        claim("peers-converge", hashes.get(final.seq) === final.hash, { document, scene: file.scene, peer: final.peer, seq: final.seq });
      }
      met += concurrent(file, journal).length;
      sameNode += concurrent(file, journal, true).length;
    }
  }
  guard("peers-converge", met > 0, { met });
  if (sameNode > 0) reached("R6", { sameNode });
  say(`[finally_peers_converge] ${String(documents.length)} documents replayed, ${String(peers)} peers compared, ${String(met)} ops met concurrency (${String(sameNode)} on the same node)`);
}

// --- finally_jobs ---------------------------------------------------------------------------------------------------
/** Every job the drivers started: one per key, claimed once per attempt, each step once, and a run that ended early left the document valid. */
export async function finallyJobs(): Promise<void> {
  const runs = jobs().filter((job) => job.kind === "run");
  let [replayed, staleFound, endedEarly] = [0, 0, 0];
  for (const job of jobs().filter((each) => each.key !== undefined)) {
    const answers = job.answers ?? [];
    const made = job.instruction === undefined ? 1 : Number((await sql<{ n: string }>("select count(*) as n from jobs where document_id = $1 and input ->> 'instruction' = $2", [job.document, job.instruction]))[0]?.n ?? 0);
    const one = new Set(answers).size === 1 && made === 1;
    claim("one-job-per-idempotency-key", one, { key: job.key ?? "", answers, made });
    if (one && answers.length > 1) replayed++;
  }
  guard("one-job-per-idempotency-key", replayed > 0, { replayed });

  const after: RunAfter[] = [];
  const steps = new Map<string, number>();
  for (const job of runs) {
    const row = await jobRow(job.id);
    const [counted] = await sql<{ ops: number; op_ids: number; nodes: number; last: string }>("select count(*)::int as ops, count(distinct op_id)::int as op_ids, count(distinct op ->> 'nodeId')::int as nodes, coalesce(max(extract(epoch from created_at) * 1000), 0)::bigint as last from op_journal where run_id = $1", [job.id]);
    const [seqs] = await sql<{ seqs: number; high: number }>("select count(distinct seq)::int as seqs, coalesce(max(seq), 0)::int as high from op_journal where document_id = $1", [job.document]);
    const [ops, opIds, nodes] = [counted?.ops ?? 0, counted?.op_ids ?? 0, counted?.nodes ?? 0];
    if (job.expect === "succeeded" && job.steps !== undefined) {
      steps.set(job.id, job.steps);
      // rebuild.ts holds a run to ONE claim; a run whose worker the scenario killed or froze was owed one more per fault.
      after.push({ id: job.id, status: row?.status ?? "gone", attempts: (row?.attempts ?? 0) - ((job.attempts ?? 1) - 1), ops, opIds, nodes, seqs: seqs?.seqs ?? 0, maxSeq: seqs?.high ?? 0 });
      continue;
    }
    // A run that was to end early: it did, with a reason; it journaled nothing after its end; what it had applied is each there once.
    const status = row?.status ?? "gone";
    const reasoned = status === job.expect && (status !== "failed" || row?.error != null);
    const quietAfter = Number(counted?.last ?? 0) <= (row?.finished ?? 0);
    claim("failed-ai-run-leaves-document-valid", reasoned && quietAfter && ops === opIds && ops === nodes, { run: job.id, status, error: row?.error ?? null, ops, opIds, nodes, lastOpAt: Number(counted?.last ?? 0), finishedAt: row?.finished ?? 0 });
    if (reasoned && ops > 0) endedEarly++;
    if (job.stale) {
      // The message was in Redis, the job was cancelled under it, the message is gone, and the job was never claimed.
      const dropped = job.stale.waited && job.stale.consumed && status === "cancelled" && row?.attempts === 0 && ops === 0;
      claim("job-claimed-once-per-attempt", row?.attempts === 0 && ops === 0, { run: job.id, what: "a cancelled job's message claimed nothing", attempts: row?.attempts ?? null, ops });
      if (dropped) staleFound++;
    }
  }
  const wrong = runViolations({ steps, runs: after, waitingAtWipe: 1, runningAtWipe: 1 }); // its vacuity lines are the scene's guard, not asked here
  claim("job-claimed-once-per-attempt", wrong.length === 0, { runs: after.length, wrong: wrong.slice(0, 5) });
  guard("job-claimed-once-per-attempt", staleFound > 0, { staleFound });
  guard("failed-ai-run-leaves-document-valid", endedEarly > 0, { endedEarly });
  say(`[finally_jobs] ${String(runs.length)} runs: ${String(after.length)} to succeed (${String(wrong.length)} wrong), ${String(endedEarly)} ended early with ops applied, ${String(replayed)} keys replayed, ${String(staleFound)} stale messages dropped`);
  for (const line of wrong) say(`  ${line}`);
}

// --- finally_ship ---------------------------------------------------------------------------------------------------
/** Gitea: one open pull request per shipped document, and the file on its branch is the codegen of the document at a seq it had. */
export async function finallyShip(): Promise<void> {
  const [url, token] = [process.env["GITEA_URL"] ?? "http://gitea:3000", process.env["GITEA_TOKEN"] ?? ""];
  const gitea = (path: string): Promise<Response> => fetch(`${url}/api/v1/repos/noon/sample-app${path}`, { headers: { authorization: `token ${token}` } });
  const ships = jobs().filter((job) => job.kind === "ship");
  let [reused, pushed] = [0, 0];
  for (const document of new Set(ships.map((job) => job.document))) {
    const branch = `noon/${document}`;
    const outputs = (await Promise.all(ships.filter((job) => job.document === document).map((job) => jobRow(job.id)))).filter((row) => row?.status === "succeeded").map((row) => row?.output as { commit: string | null; pr: { number: number } | null } | null);
    const pulls: { head: { ref: string } }[] = [];
    for (let page = 1; ; page++) {
      const listed = (await (await gitea(`/pulls?state=open&limit=50&page=${String(page)}`)).json()) as { head: { ref: string } }[];
      pulls.push(...listed);
      if (listed.length < 50) break;
    }
    const open = pulls.filter((pull) => pull.head.ref === branch).length;
    claim("one-open-pr-per-document", open <= 1 && (outputs.length === 0 || open === 1), { document, open, ships: outputs.length });
    if (outputs.length > 1 && new Set(outputs.map((output) => output?.pr?.number)).size === 1) reused++;
    pushed += outputs.filter((output) => typeof output?.commit === "string").length;

    // The ship read the room's document at SOME seq (it records none): the file must be the codegen at one of them.
    const file = await gitea(`/raw/${encodeURIComponent(`src/pages/noon-${document}.tsx`)}?ref=${encodeURIComponent(branch)}`);
    const tsx = file.ok ? await file.text() : undefined;
    const doc = emptyDoc();
    const candidates: number[] = [];
    const journal = await journalOf(document);
    for (const row of [undefined, ...journal]) {
      if (row) applyOpInto(doc, row.op);
      const generated = generate(doc, manifest);
      if (generated.ok && generated.tsx === tsx) candidates.push(row?.seq ?? 0);
    }
    if (outputs.length > 0) claim("shipped-page-equals-codegen", candidates.length > 0, { document, file: file.status, matchesSeq: candidates.at(-1) ?? null, journal: journal.length });
  }
  guard("one-open-pr-per-document", reused > 0, { reused });
  guard("shipped-page-equals-codegen", pushed > 0, { pushed });
  say(`[finally_ship] ${String(ships.length)} ships: ${String(pushed)} commits pushed, ${String(reused)} documents whose second ship reused the pull request`);
}

// --- finally_sut_logs -----------------------------------------------------------------------------------------------
/**
 * What only the SUT's own output shows, since no SDK call lives in the unchanged images: the fence refusing a
 * zombie's append (Postgres's statement log) and a stalled attempt waking up (the worker's log). run.sh puts the
 * services' logs since the last reset under logs/; inside Antithesis there are none here, and nothing is asserted.
 */
export async function finallySutLogs(): Promise<void> {
  const postgres = state.text("logs/postgres.log");
  if (postgres !== undefined) {
    const all = statements(postgres);
    const stale = staleAppends(all);
    const rows = new Set((await sql<{ key: string }>("select document_id || ':' || seq || ':' || op_id as key from op_journal")).map((row) => row.key));
    for (const append of landed(all, (each) => rows.has(`${each.document}:${String(each.seq)}:${each.opId}`))) happened("zombie-owner-append-fenced", { ...append });
    guard("zombie-owner-append-fenced", stale.length > 0, { staleAppends: stale.length, appends: all.filter((each) => each.kind === "append").length, claims: all.filter((each) => each.kind === "claim").length });
    if (stale.length > 0) sawWindow("R2", { staleAppends: stale.length });
    say(`[finally_sut_logs] postgres: ${String(all.length)} claims and appends, ${String(stale.length)} appends under a claim that was no longer the document's`);
  }
  const workers = ["worker", "worker-2"].map((name) => state.text(`logs/${name}.log`)).filter((text) => text !== undefined);
  if (workers.length > 0) {
    const woke = workers.join("\n").split("\n").filter((line) => line.includes("job taken over after a silence: stopping this attempt")).length;
    guard("superseded-attempt-writes-nothing", woke > 0, { woke });
    if (woke > 0) sawWindow("R7", { woke });
    say(`[finally_sut_logs] workers: ${String(woke)} stalled attempts woke up after their job was given away`);
  }
}

// --- finally_windows_reached (dangerous-windows-reached) ------------------------------------------------------------
/** R1 and R6 are judged from the ledgers (above); the others were seen by a scene or in the SUT's logs, and kept. */
export function finallyWindowsReached(): void {
  const seen = state.lines<{ window: Window }>("facts.jsonl");
  for (const fact of seen) reached(fact.window, fact);
  say(`[finally_windows_reached] ${[...new Set(seen.map((fact) => fact.window))].sort().join(" ") || "none of R2 R3 R4 R5 R7"}`);
}
