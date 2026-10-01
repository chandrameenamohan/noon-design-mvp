// The scenes: workloads that know a fault is coming. Local only (inside Antithesis the platform chooses the faults
// and the test template's commands are all there is). run.sh holds Docker and toxiproxy, so IT opens each fault; a
// scene says when (a `@@ cue` line: faults are triggered off lines, never sleeps) and waits for run.sh's answer.
// A scene asserts only what nobody but it can see (what its own peers were told, a job row at the instant of a
// kill); everything else it leaves in the ledger and the job notes for the checks.
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { sawWindow } from "./checks.ts";
import { openLedger } from "./ledger.ts";
import { claim, guard } from "./sdk.ts";
import { config, cue, holderOf, live, must, newDocument, peerOf, redis, say, sleep, sql, until, world, type DriverPeer, type Holder } from "./world.ts";
import { agentRows, ended, gap, jobRow, keep, labelOn, noteJob, PUSH_BUDGET_MS, pushLabel, sameSeq, shippedButton, stack, startRun, type JobNote } from "./workload.ts";

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

// --- upgrade-reset: a connection the node refuses is reset by its client ---------------------------------------------------
/**
 * Found by Z.3's baseline under load: a sync node died of an unhandled ECONNRESET. The fault is a client's, so the
 * scene makes it itself, at the sync node's own door: an upgrade with no valid token, which the node answers 401,
 * and then a TCP reset instead of a goodbye (a killed process, a scanner). Aimed at the owner of an open room that
 * is being edited. The node must not notice: run.sh looks for a dead container before anything is started again.
 */
export async function upgradeReset(): Promise<void> {
  const { document, ledger, all, edit, close } = await room("upgrade-reset");
  const knock = (host: string, afterMs: number): Promise<void> => new Promise((resolve) => {
    // 3001: the port compose gives both sync nodes (SYNC_PUBLIC_URL).
    const socket = connect(3001, host, () => {
      socket.write(["GET /documents/" + document + " HTTP/1.1", "Host: " + host, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: " + randomBytes(16).toString("base64"), "Sec-WebSocket-Version: 13", "Sec-WebSocket-Protocol: noon.v1, no-such-token", "", ""].join("\r\n"), () => {
        setTimeout(() => { socket.resetAndDestroy(); resolve(); }, afterMs);
      });
    });
    socket.on("error", () => { resolve(); });
  });
  try {
    const before = await ownerOf(document);
    cue.say("armed", { owner: before.node });
    await cue.wait("fault", FAULT_WAIT_MS);
    ledger.fault("upgrade-reset");
    edit(3); // on the wire while the node is knocked at
    for (let i = 0; i < 20; i++) await knock(before.node, i % 2 === 0 ? 0 : 5); // both orders: reset before the 401 is written, and after
    const stayed = !(await until(() => all.some((peer) => peer.status !== "live"), 2000)); // a dead owner's peers are told at once (TCP)
    cue.say("knocked", { stayed });
    await cue.wait("checked", FAULT_WAIT_MS);
    await must(() => all.every((peer) => peer.status === "live"), "both peers live", config.leaseTtlMs * 2 + 45_000);
    edit(3);
    await ledger.settle(30_000);
    await sameSeq(all, 30_000);
    const after = await holderOf(document);
    keep(ledger.file());
    say(`[upgrade-reset] ${document}: 20 refused upgrades reset at ${before.node}; its peers stayed connected ${String(stayed)}; the room ${JSON.stringify(before)} -> ${JSON.stringify(after ?? null)}`);
  } finally {
    close();
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


// --- webhook-dropped: Gitea's delivery never arrives -------------------------------------------------------------------
/**
 * SPEC §2a: Gitea never retries a failed delivery, so the git peer's reconcile must find the push by itself. A
 * shipped document stays OPEN (nobody reopens it: a new session would ask for a reconcile, and the timer is the
 * harder path). First a control push with the listener up, which must come through the webhook's door; then
 * run.sh cuts the listener and the engineer pushes again. `eventually_push_on_canvas` judges both from the journal.
 */
export async function webhookDropped(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `webhook-dropped ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "webhook-dropped");
  const ann = peerOf(owner, document);
  const deliveryOf = async (commit: string): Promise<string | null | undefined> => (await sql<{ delivery_id: string | null }>("select delivery_id from git_events where after_sha = $1", [commit]))[0]?.delivery_id;
  try {
    await shippedButton(owner, document, ann, ledger);
    const control = await pushLabel(document, ann.confirmed, "Pay now", false);
    await must(() => labelOn(ann) === control.label, "the control push (webhook up) reaches the canvas", PUSH_BUDGET_MS);
    const controlDelivery = await deliveryOf(control.commit);
    cue.say("armed", { document }); // the fault first, then the push
    await cue.wait("fault", FAULT_WAIT_MS);
    const since = Date.now();
    const push = await pushLabel(document, ann.confirmed, "Pay later", true);
    const shown = await until(() => labelOn(ann) === push.label, PUSH_BUDGET_MS);
    const shownMs = Date.now() - since;
    const delivery = await deliveryOf(push.commit);
    claim("dropped-webhook-push-reaches-canvas", shown, { document, commit: push.commit, shownMs, budgetMs: PUSH_BUDGET_MS, what: "the open canvas showed the push within the reconcile period and slack" });
    cue.say("applied", { shown });
    await cue.wait("healed", FAULT_WAIT_MS);
    await sameSeq([ann]);
    keep(ledger.file({ facts: { controlDelivery: controlDelivery ?? null, delivery: delivery ?? null, shownMs } }));
    say(`[webhook-dropped] ${document}: control ${control.commit.slice(0, 8)} came by ${controlDelivery == null ? "the RECONCILE (the control proved nothing)" : "the webhook"}; ${push.commit.slice(0, 8)} pushed with the listener cut, recorded by ${delivery === null ? "the reconcile" : delivery === undefined ? "NOTHING" : "the webhook (the delivery was not dropped)"}, on the canvas ${String(shown)} after ${String(shownMs)} ms`);
  } finally {
    ann.close();
  }
}

// --- worker-store-unavailable: Postgres cut from the api and the workers, past staleMs, and nobody dies ----------------
/**
 * The job store goes away under a run for longer than `staleMs` (run.sh: the `pg` listener, which the api and every
 * worker dial; the sync nodes have their own, so the run's ops keep landing). Every beat fails meanwhile. No worker
 * died, but to the product a stale heartbeat IS a dead worker (worker.ts: "if it is, the attempt fence makes the
 * slow worker stop instead of finishing twice"). So when Postgres is back it is a race, and both ends are within
 * the promise: the worker's beat lands first and the run goes on as attempt 1, or a sweep lands first, the run is
 * given away, attempt 1 stops itself and attempt 2 does the work. Never more: succeeded, each step journaled once.
 */
export async function workerStoreUnavailable(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `worker-store-unavailable ${randomUUID().slice(0, 8)}`);
  const steps = 80; // longer than the outage: the run is still going when Postgres returns
  const run = await startRun(owner, document, steps);
  await must(async () => (await agentRows(document)) >= 4, "the run is part way (4 steps journaled)", 60_000);
  cue.say("mid-run", { run }); // the fault lands mid-run: the workload is slow by construction (a step every stepMs)
  await cue.wait("fault", FAULT_WAIT_MS);
  // "Longer than staleMs" is read off the job's own row (directly, as the judge reads), never slept for.
  const silentMs = async (): Promise<number> => Number((await sql<{ silent: string }>("select (extract(epoch from now() - heartbeat_at) * 1000)::bigint as silent from jobs where id = $1", [run]))[0]?.silent ?? 0);
  await must(async () => (await silentMs()) > config.staleMs + 1000, "the job's heartbeat is older than staleMs", config.staleMs + 60_000);
  const [atHeal, journaled, silent] = [await jobRow(run), await agentRows(document), await silentMs()];
  cue.say("stale", { run, silent });
  await cue.wait("healed", FAULT_WAIT_MS);
  const finished = await until(() => ended(run), config.staleMs + 240_000);
  const after = await jobRow(run);
  // One claim, or the one more a stale heartbeat is owed: a third would be a claim nothing explains (finally_jobs fails it).
  // ponytail: the expectation is derived from what happened, so finally_jobs catches only a THIRD attempt; ceiling: a
  // second attempt the stale heartbeat did not cause would pass too; upgrade (noon-cs6.3.3): read the sweep's requeue
  // of this job from the workers' log and owe attempt 2 only when it is there.
  noteJob({ id: run, kind: "run", document, expect: "succeeded", steps, attempts: Math.min(Math.max(after?.attempts ?? 1, 1), 2) });
  if (!finished) throw new Error(`run ${run} did not end: ${after?.status ?? "gone"} as attempt ${String(after?.attempts ?? 0)}`);
  say(`[worker-store-unavailable] ${run}: Postgres away from the workers until the heartbeat was ${String(silent)} ms old (staleMs ${String(config.staleMs)}), the job ${atHeal?.status ?? "gone"} as attempt ${String(atHeal?.attempts ?? 0)} at ${String(journaled)}/${String(steps)} steps; it ended ${after?.status ?? "gone"} as attempt ${String(after?.attempts ?? 0)}${after?.error == null ? "" : ` (${after.error})`}`);
}

// --- minio-unavailable, minio-stalled: the snapshot store ---------------------------------------------------------------
/**
 * SPEC §4 "Postgres or MinIO down". A document that has a snapshot is closed, and reopened while MinIO is away
 * (run.sh: the listener cut, or left open and silent, which is "slow" taken to its end). With `open`, the fault
 * comes first while the room is still open: edits go on (the journal is the truth), the snapshot writes fail or
 * hang, then the last peer leaves and the document is reopened. Either way: nothing may be acknowledged that the
 * journal does not hold, an edit made meanwhile is refused in sight ("not loaded") or lands, and once MinIO
 * answers again the document must open and take edits.
 */
async function snapshotStore(scene: string, whileOpen: boolean): Promise<void> {
  const first = await room(scene);
  const { document, ledger, edit } = first;
  const { owner, editor } = world();
  let again: DriverPeer[] = [];
  const snapshotSeq = async (): Promise<number> => Number((await sql<{ snapshot_seq: string }>("select snapshot_seq from documents where id = $1", [document]))[0]?.snapshot_seq ?? 0);
  try {
    edit(10); // 26 ops with the room's own six: past SNAPSHOT_EVERY_OPS
    await ledger.settle(30_000);
    await must(async () => (await snapshotSeq()) > 0, "the document has a snapshot in MinIO", 30_000);
    const leave = async (): Promise<void> => {
      first.close();
      await until(async () => (await holderOf(document)) === undefined, config.leaseTtlMs + 10_000); // the last-leave snapshot, then the release (or neither: a hung write)
    };
    if (!whileOpen) await leave();
    cue.say("armed", { document }); // the fault first, then the workload
    await cue.wait("fault", FAULT_WAIT_MS);
    ledger.fault(scene);
    if (whileOpen) {
      edit(15); // 30 more: the room tries to snapshot, and cannot
      await ledger.settle(30_000).catch(() => undefined); // held to account by finally_ledger, whatever became of them
      await leave();
    }
    const seqAtFault = await snapshotSeq();
    again = [peerOf(owner, document), peerOf(editor, document)];
    const openedWhileDown = await until(() => again.every((peer) => peer.status === "live"), 8000);
    const [ann, bob] = again as [DriverPeer, DriverPeer];
    // An edit made while MinIO is away. A document that has not loaded takes none and says so there and then
    // ("not_ready": the client holds an edit only once it has had a welcome); a room that still held the document
    // takes it, and then owes it like any other.
    const during = [ledger.submit("ann", ann, stack(`during-a-${randomUUID().slice(0, 8)}`)), ledger.submit("bob", bob, stack(`during-b-${randomUUID().slice(0, 8)}`))];
    const refused = during.map((each) => (each.ok ? null : each.reason));
    cue.say("probed", { openedWhileDown });
    await cue.wait("healed", FAULT_WAIT_MS);
    const recovered = await until(() => again.every((peer) => peer.status === "live" && !peer.readOnly && peer.pendingCount === 0), 60_000);
    const fate = (ops: readonly ReturnType<DriverPeer["submit"]>[]) => Promise.all(ops.map(async (each) => (each.ok ? Promise.race([each.settled, sleep(5000).then(() => undefined)]) : undefined)));
    const taken = await fate(during);
    const after = await fate(recovered ? [ledger.submit("ann", ann, stack(`after-a-${randomUUID().slice(0, 8)}`)), ledger.submit("bob", bob, stack(`after-b-${randomUUID().slice(0, 8)}`))] : []);
    // Visible, never silent: each edit made meanwhile was either refused as "not loaded" or landed; and once MinIO
    // answers again the document opens and takes edits.
    const visible = during.every((each, i) => (each.ok ? taken[i]?.ok === true : each.reason === "not_ready"));
    const writable = recovered && after.every((outcome) => outcome?.ok === true);
    claim("storage-outage-visible-read-only", visible && writable, { document, store: "minio", scene, openedWhileDown, refused, taken: taken.map((outcome) => outcome ?? null), recovered, after: after.map((outcome) => outcome ?? null), what: "an edit made while MinIO was away was refused as not loaded or landed; once MinIO answers again the document opens and takes edits" });
    keep(ledger.file({ facts: { openedWhileDown, recovered, snapshotSeqAtFault: seqAtFault, snapshotSeq: await snapshotSeq() } }));
    say(`[${scene}] ${document}: snapshot at ${String(seqAtFault)}; opened while MinIO was away ${String(openedWhileDown)}; edits made meanwhile: refused ${JSON.stringify(refused)}, taken ${JSON.stringify(taken)}; after it came back: live and writable ${String(recovered)}, new edits ${JSON.stringify(after)}`);
  } finally {
    first.close();
    for (const peer of again) peer.close();
  }
}
export const minioClosed = (): Promise<void> => snapshotStore("minio-reopen", false);
export const minioOpen = (): Promise<void> => snapshotStore("minio-open", true);
