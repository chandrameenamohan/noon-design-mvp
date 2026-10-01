// The scenes: workloads that know a fault is coming. Local only (inside Antithesis the platform chooses the faults
// and the test template's commands are all there is). run.sh holds Docker and toxiproxy, so IT opens each fault; a
// scene says when (a `@@ cue` line: faults are triggered off lines, never sleeps) and waits for run.sh's answer.
// A scene asserts only what nobody but it can see (what its own peers were told, a job row at the instant of a
// kill); everything else it leaves in the ledger and the job notes for the checks.
import { randomUUID } from "node:crypto";
import { sawWindow } from "./checks.ts";
import { openLedger } from "./ledger.ts";
import { claim, guard } from "./sdk.ts";
import { config, cue, holderOf, live, must, newDocument, peerOf, redis, say, sleep, sql, until, world, type DriverPeer, type Holder } from "./world.ts";
import { agentRows, ended, gap, jobRow, keep, noteJob, sameSeq, stack, startRun, type JobNote } from "./workload.ts";

const FAULT_WAIT_MS = 120_000;
const fenceOf = async (document: string): Promise<number> => Number((await sql<{ fence_token: string }>("select fence_token from documents where id = $1", [document]))[0]?.fence_token ?? 0);
const ownerOf = async (document: string): Promise<Holder> => {
  let holder: Holder | undefined;
  await must(async () => (holder = await holderOf(document)) !== undefined, `a sync node holds the lease of ${document}`, 15_000);
  return holder as unknown as Holder;
};

/** Two people in a fresh document with a few nodes each, acknowledged: where every room scene starts. */
async function room(scene: string, options: { ackTimeoutMs?: number } = {}) {
  const { owner, editor } = world();
  const document = await newDocument(owner, `${scene} ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, scene);
  const peers: [string, DriverPeer][] = [["ann", peerOf(owner, document, options)], ["bob", peerOf(editor, document, options)]];
  const all = peers.map(([, peer]) => peer);
  await live(all, "both peers live");
  for (let i = 0; i < 3; i++) for (const [name, peer] of peers) ledger.submit(name, peer, stack(`${name}${String(i)}`));
  await ledger.settle(30_000);
  await sameSeq(all, 30_000);
  let made = 0;
  /** `count` edits by each peer: a prop of one of its own nodes, to a value it does not have yet (so each is one journal append). */
  const edit = (count: number): void => {
    for (let i = 0; i < count; i++, made++) for (const [name, peer] of peers) ledger.submit(name, peer, gap(`${name}${String(made % 3)}`, 100 + made));
  };
  return { document, ledger, peers, all, edit, close: (): void => { for (const peer of all) peer.close(); } };
}

/** The room after its owner went: who holds it now, under which fence, and how long the move took. */
async function moved(document: string, before: Holder, since: number, elsewhere: boolean): Promise<{ before: Holder; after: Holder; fenceToken: number; moveMs: number }> {
  let after: Holder | undefined;
  await must(async () => {
    after = await holderOf(document);
    return after !== undefined && after.token > before.token && (!elsewhere || after.node !== before.node);
  }, "a node holds the room under a larger token", config.leaseTtlMs * 2 + 45_000);
  return { before, after: after as unknown as Holder, moveMs: Date.now() - since, fenceToken: await fenceOf(document) };
}

// --- sync-killed: dies mid-step ---------------------------------------------------------------------------------------
/**
 * A burst of edits is on the wire and the room's owner is killed under it (run.sh: `docker kill -s KILL`, off the
 * `burst` cue). run.sh has slowed Postgres's ANSWERS to the sync nodes first, so the kill finds an append that
 * Postgres committed and the room never announced: the op its sender must resend, and the journal must answer.
 */
export async function syncKilled(): Promise<void> {
  const { document, ledger, all, edit, close } = await room("sync-killed", { ackTimeoutMs: 4000 });
  try {
    const before = await ownerOf(document);
    edit(12);
    cue.say("burst", { owner: before.node });
    await cue.wait("fault", FAULT_WAIT_MS);
    ledger.fault("sync-killed");
    const since = Date.now();
    guard("room-recovers-after-owner-death", all.every((peer) => peer.node() === before.node), { document, killed: before.node, peers: all.map((peer) => peer.node()) });
    await must(() => all.every((peer) => peer.status !== "live"), "both peers see the owner gone", 30_000);
    edit(2); // made while the room has no owner: held, sent after the next welcome
    const lease = await moved(document, before, since, true);
    await must(() => all.every((peer) => peer.status === "live" && peer.pendingCount === 0), "both peers reconnected unaided, nothing pending", 60_000);
    edit(3);
    await ledger.settle(30_000);
    await sameSeq(all, 30_000);
    // The measurement the catalog asks for: the move takes about one lease ttl (the dead owner's lease must expire).
    claim("room-recovers-after-owner-death", lease.moveMs <= config.leaseTtlMs * 2 + 10_000, { document, moveMs: lease.moveMs, leaseTtlMs: config.leaseTtlMs, what: "the room moved within two lease ttls and slack" });
    keep(ledger.file({ lease, facts: { moveMs: lease.moveMs } }));
    say(`[sync-killed] ${document}: ${before.node} -> ${lease.after.node} in ${String(lease.moveMs)} ms (ttl ${String(config.leaseTtlMs)})`);
  } finally {
    close();
  }
}

// --- sync-paused: stalls past its lease --------------------------------------------------------------------------------
/**
 * The zombie (F22). run.sh first delays what the owner SENDS to Postgres by more than a lease; then one edit per
 * peer leaves the owner as an append, and the owner is frozen (`docker pause`) with that append still on its way.
 * Its lease expires, another node claims the document and the peers move there, resending. Only then does the
 * zombie's append reach Postgres, under a claim that is no longer the document's: the fence must refuse it.
 * (Edits sent into a frozen owner prove nothing: it wakes through its timers, drops the room, and never reads them.)
 */
export async function syncPaused(): Promise<void> {
  const { document, ledger, all, edit, close } = await room("sync-paused", { ackTimeoutMs: 2500 });
  try {
    const before = await ownerOf(document);
    cue.say("armed", { owner: before.node });
    await cue.wait("slowed", FAULT_WAIT_MS);
    edit(1); // the first is on its way to Postgres, slowly; the second waits its turn in the room
    cue.say("burst", { owner: before.node });
    await cue.wait("fault", FAULT_WAIT_MS);
    ledger.fault("sync-paused");
    const since = Date.now();
    edit(2); // into the frozen owner's socket
    await must(() => all.every((peer) => peer.status !== "live"), "both peers give the silent owner up", 30_000);
    const lease = await moved(document, before, since, true);
    await must(() => all.every((peer) => peer.status === "live" && peer.pendingCount === 0), "both peers on the new owner, nothing pending", 60_000);
    cue.say("moved", { to: lease.after.node });
    await cue.wait("resumed", FAULT_WAIT_MS);
    await sleep(1500); // the zombie is awake: whatever it still does happens now; then these must land, on the new owner
    edit(4);
    await ledger.settle(30_000);
    await sameSeq(all, 30_000);
    keep(ledger.file({ lease: { ...lease, fenceToken: await fenceOf(document) } }));
    say(`[sync-paused] ${document}: ${before.node} (token ${String(before.token)}) frozen, ${lease.after.node} took it under ${String(lease.after.token)}`);
  } finally {
    close();
  }
}

// --- store-unavailable: Postgres cut from the sync nodes -----------------------------------------------------------------
/** SPEC §4: every peer is told read-only, nothing is acknowledged meanwhile, and the op held across the outage lands once. */
export async function storeUnavailable(): Promise<void> {
  const { owner, editor, viewer } = world();
  const document = await newDocument(owner, `store-unavailable ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "store-unavailable");
  let down = false;
  let heardWhileDown = 0;
  const onOp = (): void => { if (down) heardWhileDown++; };
  const [ann, bob, vic] = [peerOf(owner, document, { onOp }), peerOf(editor, document, { onOp }), peerOf(viewer, document, { onOp })];
  const all = [ann, bob, vic];
  try {
    await live(all, "three peers live");
    ledger.submit("ann", ann, stack("before"));
    await ledger.settle(15_000);
    await sameSeq(all);
    const seqBefore = ann.seq;
    cue.say("armed"); // the fault first, then the workload: a fast pipeline outruns a late fault
    await cue.wait("fault", FAULT_WAIT_MS);
    ledger.fault("store-unavailable");
    const held = ledger.submit("ann", ann, stack("held"));
    const told = await until(() => all.every((peer) => peer.readOnly), 30_000);
    down = told;
    guard("storage-outage-visible-read-only", told, { document });
    // The append of `held` is what failed: the room refused it "unavailable" and took no seq for it.
    guard("journal-seq-contiguous", told && ann.pendingCount === 1 && ann.seq === seqBefore, { document, pending: ann.pendingCount });
    if (told) sawWindow("R3", { document });
    const refused = bob.submit(stack("refused-while-read-only"));
    const connected = all.every((peer) => peer.status === "live");
    await sleep(1500); // an acknowledgement given while the store is away would arrive in here
    const quiet = heardWhileDown === 0 && ann.pendingCount === 1 && ann.seq === seqBefore;
    cue.say("read-only");
    await cue.wait("healed", FAULT_WAIT_MS);
    down = false;
    const writable = await until(() => all.every((peer) => !peer.readOnly), 60_000);
    const outcome = held.ok ? await Promise.race([held.settled, sleep(30_000).then(() => undefined)]) : undefined;
    const once = outcome?.ok === true && outcome.seq === seqBefore + 1;
    claim("storage-outage-visible-read-only", told && !refused.ok && connected && quiet && writable && once, {
      document, told, refusedLocally: !refused.ok && refused.reason, connected, heardWhileDown, writable, held: outcome ?? null, expectedSeq: seqBefore + 1,
    });
    await sameSeq([ann, bob], 30_000);
    keep(ledger.file());
    say(`[store-unavailable] ${document}: read-only ${String(told)}, acknowledged while down ${String(heardWhileDown)}, held op -> ${JSON.stringify(outcome)}`);
  } finally {
    for (const peer of all) peer.close();
  }
}

// --- worker-killed: dies mid-run ----------------------------------------------------------------------------------------
/** F28: an AI run's worker is killed part way; another worker must finish the run as its second attempt, each step once. */
export async function workerKilled(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `worker-killed ${randomUUID().slice(0, 8)}`);
  const steps = 20;
  const run = await startRun(owner, document, steps);
  await must(async () => (await agentRows(document)) >= 5, "the run is part way (5 steps journaled)", 60_000);
  cue.say("mid-run", { run });
  await cue.wait("fault", FAULT_WAIT_MS);
  const [atKill, journaled] = [await jobRow(run), await agentRows(document)];
  const midRun = atKill?.status === "running" && atKill.attempts === 1 && journaled > 0 && journaled < steps;
  guard("killed-worker-job-resumes", midRun, { run, atKill: atKill ?? null, journaled, steps });
  if (midRun) sawWindow("R4", { run, journaled, steps });
  noteJob({ id: run, kind: "run", document, expect: "succeeded", steps, attempts: 2, ...(atKill ? { heartbeatAtKill: atKill.heartbeat } : {}) });
  await must(() => ended(run), "the run ends on the other worker", config.staleMs + 120_000);
  const after = await jobRow(run);
  say(`[worker-killed] ${run}: killed at ${String(journaled)}/${String(steps)} steps; now ${after?.status ?? "gone"} as attempt ${String(after?.attempts ?? 0)}, which began ${String((after?.started ?? 0) - (atKill?.heartbeat ?? 0))} ms after the dead worker's last heartbeat (staleMs ${String(config.staleMs)})`);
}

// --- worker-paused: stalls past staleMs ---------------------------------------------------------------------------------
/**
 * The worker is frozen mid-run; its job goes stale and another worker takes it as attempt 2. The first is woken
 * while attempt 2 runs: everything it still tries to write names attempt 1, and must change nothing.
 */
export async function workerPaused(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `worker-paused ${randomUUID().slice(0, 8)}`);
  const steps = 40;
  const run = await startRun(owner, document, steps);
  await must(async () => (await agentRows(document)) >= 4, "the run is part way (4 steps journaled)", 60_000);
  cue.say("mid-run", { run });
  await cue.wait("fault", FAULT_WAIT_MS);
  const journaled = await agentRows(document);
  noteJob({ id: run, kind: "run", document, expect: "succeeded", steps, attempts: 2 });
  await must(async () => {
    const row = await jobRow(run);
    return row?.attempts === 2 && row.status === "running" && (await agentRows(document)) > journaled + 1;
  }, "another worker runs the job as attempt 2", config.staleMs + 120_000);
  cue.say("retaken", { run });
  await cue.wait("resumed", FAULT_WAIT_MS);
  await must(() => ended(run), "the run ends", 180_000);
  await sleep(2000); // a late write of the woken attempt would land in here
  const row = await jobRow(run);
  const [counted] = await sql<{ ops: number; nodes: number; usage: number }>("select (select count(*) from op_journal where run_id = $1::text)::int as ops, (select count(distinct op ->> 'nodeId') from op_journal where run_id = $1::text)::int as nodes, (select count(*) from usage where job_id = $1::uuid)::int as usage", [run]);
  claim("superseded-attempt-writes-nothing", row?.status === "succeeded" && row.attempts === 2 && counted?.ops === steps && counted.nodes === steps && counted.usage <= 1, { run, row: row ?? null, counted: counted ?? null, steps });
  say(`[worker-paused] ${run}: frozen at ${String(journaled)}/${String(steps)}; ended ${row?.status ?? "gone"} as attempt ${String(row?.attempts ?? 0)} ${JSON.stringify(counted)}`);
}

// --- redis-wiped --------------------------------------------------------------------------------------------------------
/**
 * SPEC §4 "Redis lost" (as scripts/chaos/redis-wipe-rebuild.ts): four long runs fill the worker and three more
 * wait in Redis, and only there; a room is open and being edited. Then FLUSHALL. Postgres is the truth: every run
 * must still succeed, claimed once, and the room must be owned again under a larger token.
 */
export async function redisWiped(): Promise<void> {
  const { owner } = world();
  const { document, ledger, all, edit, close } = await room("redis-wiped");
  let stream: NodeJS.Timeout | undefined;
  try {
    const before = await ownerOf(document);
    const notes: JobNote[] = [];
    const start = async (steps: number): Promise<{ run: string; document: string }> => {
      const of = await newDocument(owner, `redis-wiped run ${randomUUID().slice(0, 8)}`);
      const run = await startRun(owner, of, steps);
      notes.push({ id: run, kind: "run", document: of, expect: "succeeded", steps, wiped: true });
      return { run, document: of };
    };
    const long = await Promise.all([1, 2, 3, 4].map(() => start(40)));
    await must(async () => (await Promise.all(long.map((each) => agentRows(each.document)))).every((rows) => rows >= 3), "the four long runs are part way", 90_000);
    await Promise.all([1, 2, 3].map(() => start(5)));
    await must(async () => (await redis().llen("bull:ai:wait")) >= 3, "three runs wait in Redis", 20_000);
    const waitingAtWipe = await redis().llen("bull:ai:wait");
    const runningAtWipe = (await Promise.all(long.map((each) => jobRow(each.run)))).filter((row) => row?.status === "running").length;
    for (const note of notes) noteJob(note);
    // Edits never touch Redis: what the peers meet is the owner giving the room up at its next renewal. A steady
    // stream keeps edits on the wire until that moment.
    stream = setInterval(() => { edit(1); }, 100);
    cue.say("ready-for-wipe", { waitingAtWipe, runningAtWipe });
    await cue.wait("fault", FAULT_WAIT_MS);
    const since = Date.now();
    await must(() => all.some((peer) => peer.status !== "live"), "the room's owner gives it up (its lease is gone)", 30_000);
    await must(() => all.some((peer) => peer.pendingCount > 0), "a peer holds an edit across the room's move", 10_000);
    ledger.fault("redis-wiped");
    clearInterval(stream);
    edit(3);
    const lease = await moved(document, before, since, false);
    await must(() => all.every((peer) => peer.status === "live" && peer.pendingCount === 0), "both peers live again, nothing pending", 60_000);
    edit(3);
    await ledger.settle(30_000);
    await sameSeq(all, 30_000);
    guard("redis-loss-jobs-rebuilt", waitingAtWipe > 0 && runningAtWipe > 0, { waitingAtWipe, runningAtWipe });
    if (waitingAtWipe > 0 && runningAtWipe > 0) sawWindow("R5", { waitingAtWipe, runningAtWipe });
    keep(ledger.file({ lease: { ...lease, fenceToken: await fenceOf(document) }, facts: { waitingAtWipe, runningAtWipe } }));
    await must(async () => (await Promise.all(notes.map((note) => ended(note.id)))).every(Boolean), "every run ends", 240_000);
    say(`[redis-wiped] ${document}: ${String(waitingAtWipe)} waiting and ${String(runningAtWipe)} running at the wipe; lease ${JSON.stringify(before)} -> ${JSON.stringify(lease.after)}`);
  } finally {
    clearInterval(stream);
    close();
  }
}

