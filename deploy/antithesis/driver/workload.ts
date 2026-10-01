// The workload: what the test template's `first_` and `parallel_driver_` commands do. Each is one process with
// documents of its own, knows nothing of faults (inside Antithesis the platform injects them), and leaves what it
// did in the run's state: an op ledger per document, a line per job, a line per revoke. The checks read those.
import { randomUUID } from "node:crypto";
import { generate } from "@noon/codegen";
import type { Doc, Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { openLedger, type LedgerFile } from "./ledger.ts";
import { claim, guard, ready } from "./sdk.ts";
import { call, config, live, must, newDocument, ok, peerOf, redis, say, sleep, sql, state, until, world, type DriverPeer, type World } from "./world.ts";

export const stack = (nodeId: string, parentId = "root"): Op => ({ type: "add_node", nodeId, parentId, index: 0, component: "Stack", props: {} });
export const gap = (nodeId: string, value: number): Op => ({ type: "set_prop", nodeId, key: "gap", value });
const move = (nodeId: string, newParentId: string): Op => ({ type: "move_node", nodeId, newParentId, index: 0 });

/** A job a driver started, and what the checks should hold it to. */
export type JobNote = {
  id: string; kind: "run" | "ship"; document: string;
  /** How a run must end; a ship must always succeed. */
  expect: "succeeded" | "cancelled" | "failed";
  steps?: number;
  /** Claims the job should have had: 1, plus one per worker that died or froze under it. */
  attempts?: number;
  /** F27: the idempotency key, the unique instruction it was sent with, and the id each request with it was answered. */
  key?: string; instruction?: string; answers?: string[];
  /** The job's last heartbeat when its worker was killed (ms, Postgres's clock): a retry must not come sooner than staleMs after it. */
  heartbeatAtKill?: number;
  /** Cancelled while its message waited in Redis: the message then finds nothing to claim. `consumed`: it left Redis. */
  stale?: { waited: boolean; consumed: boolean };
  /** Waiting or running when Redis was wiped. */
  wiped?: boolean;
};
export const noteJob = (note: JobNote): void => { state.append("jobs.jsonl", note); };
export const keep = (file: LedgerFile): void => { state.write(`ledger/${file.document}.${String(process.pid)}.json`, file); };

export const agentRows = async (document: string): Promise<number> => Number((await sql<{ n: string }>("select count(*) as n from op_journal where document_id = $1 and actor_kind = 'agent'", [document]))[0]?.n ?? 0);
export type JobRow = { status: string; attempts: number; heartbeat: number; started: number; finished: number; error: string | null; output: unknown };
export async function jobRow(id: string): Promise<JobRow | undefined> {
  const [row] = await sql<{ status: string; attempts: number; heartbeat: string; started: string; finished: string; error: string | null; output: unknown }>(
    "select status, attempts, coalesce(extract(epoch from heartbeat_at) * 1000, 0)::bigint as heartbeat, coalesce(extract(epoch from started_at) * 1000, 0)::bigint as started, coalesce(extract(epoch from finished_at) * 1000, 0)::bigint as finished, error, output from jobs where id = $1", [id]);
  return row && { ...row, heartbeat: Number(row.heartbeat), started: Number(row.started), finished: Number(row.finished) };
}
export const ended = async (id: string): Promise<boolean> => ["succeeded", "failed", "cancelled"].includes((await jobRow(id))?.status ?? "");
export const sameSeq = (peers: readonly DriverPeer[], timeoutMs = 20_000): Promise<void> => must(() => peers.every((peer) => peer.status === "live" && peer.pendingCount === 0 && peer.seq === peers[0]?.seq), "every peer at the same seq with nothing pending", timeoutMs);

/** Starts an AI run of `steps` scripted steps; `extra` rides in the instruction (the stub reads only `nodes=` and `fail=`). */
export async function startRun(as: string, document: string, steps: number, extra = ""): Promise<string> {
  return (await ok(as, "POST", `/documents/${document}/runs`, { instruction: `nodes=${String(steps)}${extra === "" ? "" : ` ${extra}`}` }, { "idempotency-key": randomUUID() })).id;
}

// --- first_setup --------------------------------------------------------------------------------------------------
/** The people, the two orgs, and Gitea's repo with the push webhook. Safe to run again: it keeps a world that still answers. */
export async function setup(): Promise<void> {
  const existing = state.read("world.json") as World | undefined;
  if (!existing || (await call(existing.owner, "GET", `/orgs/${existing.org}`)).status !== 200) {
    const [owner, editor, viewer, outsider, stranger] = ["owner", "editor", "viewer", "outsider", "stranger"].map((name) => `${name}@harness.test`) as [string, string, string, string, string];
    const idOf = async (email: string): Promise<string> => (await ok<{ user: { id: string } }>(email, "GET", "/auth/me")).user.id; // the first sight of a user creates it
    const [viewerId, outsiderId] = [await idOf(viewer), await idOf(outsider)];
    await idOf(editor);
    const org = (await ok(owner, "POST", "/orgs", { name: "harness" })).id;
    await ok(owner, "PUT", `/orgs/${org}/members`, { email: editor, role: "editor" });
    await ok(owner, "PUT", `/orgs/${org}/members`, { email: viewer, role: "viewer" });
    const workspace = (await ok(owner, "POST", `/orgs/${org}/workspaces`, { name: "harness" })).id;
    const strangerOrg = (await ok(stranger, "POST", "/orgs", { name: "strangers" })).id;
    const strangerWorkspace = (await ok(stranger, "POST", `/orgs/${strangerOrg}/workspaces`, { name: "strangers" })).id;
    const strangerDoc = (await ok(stranger, "POST", `/orgs/${strangerOrg}/workspaces/${strangerWorkspace}/documents`, { title: "the stranger's own" })).id;
    state.write("world.json", { org, workspace, owner, editor, viewer, viewerId, outsider, outsiderId, stranger, strangerOrg, strangerDoc } satisfies World);
  }
  await gitea();
  ready({ org: world().org });
  say("[first_setup] ok");
}

/** Gitea's own API, as the harness's user (read DIRECTLY, never through toxiproxy: the judge and the "engineer" are not the SUT). */
const giteaApi = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${process.env["GITEA_URL"] ?? "http://gitea:3000"}/api/v1${path}`, { method, headers: { authorization: `token ${process.env["GITEA_TOKEN"] ?? ""}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Gitea's repo noon/sample-app with a `main` to branch from, and the push webhook to the api (through toxiproxy). */
async function gitea(): Promise<void> {
  const api = giteaApi;
  // auto_init: one commit on main, which is all Ship needs (it adds the document's page on a branch of its own).
  const made = await api("POST", "/user/repos", { name: "sample-app", private: true, default_branch: "main", auto_init: true });
  if (!made.ok && made.status !== 409) throw new Error(`Gitea POST /user/repos -> ${String(made.status)}: ${await made.text()}`);
  await must(async () => (await api("GET", "/repos/noon/sample-app/branches/main")).ok, "Gitea's main branch is readable", 30_000);
  const hook = { active: true, events: ["push"], config: { url: process.env["GITEA_WEBHOOK_URL"] ?? "", content_type: "json", secret: process.env["GITEA_WEBHOOK_SECRET"] ?? "" } };
  const hooks = (await (await api("GET", "/repos/noon/sample-app/hooks")).json()) as { config: { url?: string } }[];
  if (!hooks.some((each) => each.config.url === hook.config.url)) {
    const added = await api("POST", "/repos/noon/sample-app/hooks", { type: "gitea", ...hook });
    if (!added.ok) throw new Error(`Gitea POST hooks -> ${String(added.status)}: ${await added.text()}`);
  }
}

// --- parallel_driver_edit -----------------------------------------------------------------------------------------
/**
 * Two people build a small tree in one document, then meet: both set the same prop of the same node at once (R6),
 * and each moves a node under the other's (the second to arrive would close a cycle, and the room must refuse it).
 */
export async function edit(): Promise<void> {
  const { owner, editor } = world();
  const document = await newDocument(owner, `edit ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "edit");
  const [ann, bob] = [peerOf(owner, document), peerOf(editor, document)];
  try {
    await live([ann, bob], "both editors live");
    for (let i = 0; i < 4; i++) {
      ledger.submit("ann", ann, stack(`a${String(i)}`));
      ledger.submit("bob", bob, stack(`b${String(i)}`));
    }
    await ledger.settle(20_000);
    await sameSeq([ann, bob]);
    // From here on, in ONE turn of the event loop: neither has heard the other's op when its own leaves.
    ledger.submit("ann", ann, gap("a0", 4));
    ledger.submit("bob", bob, gap("a0", 12));
    ledger.submit("ann", ann, move("a1", "b1"));
    ledger.submit("bob", bob, move("b1", "a1"));
    await ledger.settle(20_000);
    await sameSeq([ann, bob]);
    keep(ledger.file());
    say(`[edit] ${document}: ${String(ledger.entries.length)} ops, seq ${String(ann.seq)}`);
  } finally {
    ann.close();
    bob.close();
  }
}

// --- parallel_driver_viewer_edit ----------------------------------------------------------------------------------
/** A viewer watches a document and tries to change it: the room must refuse, and nothing of theirs may be journaled. */
export async function viewerEdit(): Promise<void> {
  const { owner, viewer, viewerId } = world();
  const document = await newDocument(owner, `viewer ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "viewer-edit");
  const [ann, vic] = [peerOf(owner, document), peerOf(viewer, document)];
  try {
    await live([ann, vic], "the owner and the viewer live");
    ledger.submit("ann", ann, stack("a0"));
    await ledger.settle(15_000);
    await sameSeq([ann, vic]);
    ledger.submit("vic", vic, stack("v0"));
    ledger.submit("vic", vic, gap("a0", 2));
    await ledger.settle(15_000);
    keep(ledger.file({ viewers: [viewerId] }));
    say(`[viewer_edit] ${document}`);
  } finally {
    ann.close();
    vic.close();
  }
}

// --- parallel_driver_start_twice ----------------------------------------------------------------------------------
/** F27: the same start, twice at once, under one idempotency key: one run, and both answers name it. */
export async function startTwice(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `twice ${randomUUID().slice(0, 8)}`);
  const key = randomUUID();
  const instruction = `nodes=3 key=${key}`;
  const post = (): Promise<{ id: string }> => ok(owner, "POST", `/documents/${document}/runs`, { instruction }, { "idempotency-key": key });
  const answers = (await Promise.all([post(), post()])).map((run) => run.id);
  answers.push((await post()).id); // and once more, after the first has answered
  noteJob({ id: answers[0] ?? "", kind: "run", document, expect: "succeeded", steps: 3, key, instruction, answers });
  await must(() => ended(answers[0] ?? ""), "the run ends", 60_000);
  say(`[start_twice] ${document}: ${answers.join(" ")}`);
}

// --- parallel_driver_ai_and_person --------------------------------------------------------------------------------
/** F9: a person keeps editing while the AI builds, in the same document. */
export async function aiAndPerson(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `ai+person ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "ai-and-person");
  const ann = peerOf(owner, document);
  try {
    await live([ann], "the person live");
    const run = await startRun(owner, document, 8);
    noteJob({ id: run, kind: "run", document, expect: "succeeded", steps: 8 });
    for (let made = 0; !(await ended(run)); made++) {
      ledger.submit("ann", ann, stack(`p${String(made)}`));
      await sleep(config.stepMs / 2);
    }
    await ledger.settle(15_000);
    await sameSeq([ann]);
    keep(ledger.file());
    say(`[ai_and_person] ${document}: ${String(ledger.entries.length)} person ops beside the run`);
  } finally {
    ann.close();
  }
}

// --- parallel_driver_end_run_early --------------------------------------------------------------------------------
/** F10, SPEC §4: a run cancelled in the middle, and one the provider refuses in the middle. What they had made stays. */
export async function endRunEarly(): Promise<void> {
  const { owner } = world();
  const cancelled = await newDocument(owner, `cancelled ${randomUUID().slice(0, 8)}`);
  const run = await startRun(owner, cancelled, 30);
  noteJob({ id: run, kind: "run", document: cancelled, expect: "cancelled", steps: 30 });
  await must(async () => (await agentRows(cancelled)) >= 3, "the run is under way (3 steps journaled)", 60_000);
  await ok(owner, "POST", `/documents/${cancelled}/runs/${run}/cancel`);
  const refused = await newDocument(owner, `refused ${randomUUID().slice(0, 8)}`);
  const failing = await startRun(owner, refused, 6, "fail=3");
  noteJob({ id: failing, kind: "run", document: refused, expect: "failed", steps: 6 });
  await must(async () => (await ended(run)) && (await ended(failing)), "both runs end", 60_000);
  say(`[end_run_early] cancelled ${run}, refused ${failing}`);
}

// --- parallel_driver_stale_message --------------------------------------------------------------------------------
/**
 * A queue message that outlives its job: with every slot of the worker taken, one more run waits in Redis and is
 * cancelled there. When a slot frees, its message is delivered, and must find nothing to claim (worker.ts:104).
 */
export async function staleMessage(): Promise<void> {
  const { owner } = world();
  const SLOTS = 4; // worker.ts: a queue's default concurrency
  const busy: string[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const document = await newDocument(owner, `slot ${String(i)} ${randomUUID().slice(0, 8)}`);
    const run = await startRun(owner, document, 8);
    busy.push(run);
    noteJob({ id: run, kind: "run", document, expect: "succeeded", steps: 8 });
  }
  await must(async () => (await Promise.all(busy.map(jobRow))).every((row) => row?.status === "running"), "every slot of the worker is taken", 60_000);
  const document = await newDocument(owner, `stale ${randomUUID().slice(0, 8)}`);
  const late = await startRun(owner, document, 2);
  const waited = await until(async () => (await redis().lpos("bull:ai:wait", late)) !== null, 10_000);
  await ok(owner, "POST", `/documents/${document}/runs/${late}/cancel`);
  await must(async () => (await Promise.all(busy.map(ended))).every(Boolean), "the slots free", 90_000);
  // Delivered and dropped: BullMQ removes a finished message at once (removeOnComplete), so "gone" is "consumed".
  const consumed = await until(async () => (await redis().lpos("bull:ai:wait", late)) === null && (await redis().exists(`bull:ai:${late}`)) === 0, 30_000);
  noteJob({ id: late, kind: "run", document, expect: "cancelled", steps: 2, attempts: 0, stale: { waited, consumed } });
  say(`[stale_message] ${late}: waited in Redis ${String(waited)}, consumed ${String(consumed)}`);
}

// --- parallel_driver_ship -----------------------------------------------------------------------------------------
/** F17: Ship, an edit, Ship again. One pull request, whose file is the document's codegen. */
export async function ship(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `ship ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "ship");
  const ann = peerOf(owner, document);
  const press = async (key: string): Promise<string> => (await ok(owner, "POST", `/documents/${document}/ship`, undefined, { "idempotency-key": key })).id;
  const shipped = async (id: string): Promise<void> => {
    noteJob({ id, kind: "ship", document, expect: "succeeded" });
    await must(() => ended(id), `ship ${id} ends`, 120_000);
  };
  try {
    await live([ann], "the person live");
    ledger.submit("ann", ann, { type: "add_node", nodeId: "b1", parentId: "root", index: 0, component: "Button", props: { label: "Pay" } });
    await ledger.settle(15_000);
    await shipped(await press(randomUUID()));
    ledger.submit("ann", ann, { type: "set_prop", nodeId: "b1", key: "label", value: "Pay now" });
    await ledger.settle(15_000);
    const key = randomUUID();
    const second = await press(key);
    const again = await press(key); // a retry of the same press
    state.append("jobs.jsonl", { id: second, kind: "ship", document, expect: "succeeded", key, answers: [second, again] } satisfies JobNote);
    await must(() => ended(second), `ship ${second} ends`, 120_000);
    await sameSeq([ann]);
    keep(ledger.file());
    say(`[ship] ${document}: shipped twice`);
  } finally {
    ann.close();
  }
}

// --- parallel_driver_share_revoke ---------------------------------------------------------------------------------
/** A revoke, as the catalog's eventually check needs it remembered: the document, and that its holder was in it. */
export type Revoke = { document: string; outsider: string; wasLive: boolean };
/** F25: an outsider works in a shared document; the owner revokes the share; the outsider's page must close. */
export async function shareRevoke(): Promise<void> {
  const { owner, outsider, outsiderId } = world();
  const document = await newDocument(owner, `shared ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "share-revoke");
  const ann = peerOf(owner, document);
  let guest: DriverPeer | undefined;
  try {
    await ok(owner, "PUT", `/documents/${document}/shares`, { email: outsider, role: "editor" });
    guest = peerOf(outsider, document);
    await live([ann, guest], "the owner and the outsider live");
    ledger.submit("oto", guest, stack("o0"));
    await ledger.settle(15_000);
    await sameSeq([ann, guest]);
    const file = ledger.file(); // before the revoke closes the outsider: its last confirmed document counts
    const wasLive = guest.status === "live";
    const answer = await call(owner, "DELETE", `/documents/${document}/shares/${outsiderId}`);
    if (answer.status !== 204) throw new Error(`the revoke answered ${String(answer.status)}`);
    state.append("revokes.jsonl", { document, outsider, wasLive } satisfies Revoke);
    guard("revoked-share-loses-access", wasLive, { document });
    // The announcement closes a live session at once; the sync nodes' own sweep (30 s) is the backstop.
    const within = guest; // (narrowed for the closure)
    const closed = await until(() => within.status === "closed", 45_000);
    claim("revoked-share-loses-access", closed, { document, closedBecause: guest.closedBecause ?? null, what: "the outsider's open session is closed" });
    keep(file);
    say(`[share_revoke] ${document}: closed ${String(closed)} (${guest.closedBecause ?? "still open"})`);
  } finally {
    ann.close();
    guest?.close();
  }
}

// --- parallel_driver_engineer_push --------------------------------------------------------------------------------
/** A push an engineer made to a shipped document's branch, and what the canvas must come to show for it. */
export type PushNote = {
  document: string; commit: string; label: string;
  /** Made while run.sh had cut the webhook's listener: Gitea's delivery was refused, and Gitea never retries. */
  dropped: boolean;
};
const BUTTON = "b1";
export const labelOn = (peer: DriverPeer): unknown => peer.confirmed.nodes[BUTTON]?.props["label"];

/** A document holding one Button, shipped: its generated page is on its own branch, where an engineer can push to it. */
export async function shippedButton(as: string, document: string, ann: DriverPeer, ledger: ReturnType<typeof openLedger>): Promise<void> {
  await live([ann], "the person live");
  ledger.submit("ann", ann, { type: "add_node", nodeId: BUTTON, parentId: "root", index: 0, component: "Button", props: { label: "Pay" } });
  await ledger.settle(15_000);
  const id = (await ok(as, "POST", `/documents/${document}/ship`, undefined, { "idempotency-key": randomUUID() })).id;
  noteJob({ id, kind: "ship", document, expect: "succeeded" });
  await must(() => ended(id), `ship ${id} ends`, 120_000);
  const status = (await jobRow(id))?.status;
  if (status !== "succeeded") throw new Error(`ship ${id} ended ${status ?? "gone"}: there is no page to push to`);
}

/**
 * F16a: the engineer edits the generated page (the Button's label, so the page stays in shape) and pushes it to the
 * document's branch. Through Gitea's contents API: a commit on the branch like any `git push`, with its webhook.
 */
export async function pushLabel(document: string, now: Doc, label: string, dropped: boolean): Promise<PushNote> {
  const target = structuredClone(now);
  const button = target.nodes[BUTTON];
  if (!button) throw new Error(`${document} has no ${BUTTON} to relabel`);
  button.props["label"] = label;
  const generated = generate(target, manifest);
  if (!generated.ok) throw new Error(`codegen refused the engineer's page: ${generated.reason}`);
  const [file, branch] = [`/repos/noon/sample-app/contents/src/pages/noon-${document}.tsx`, `noon/${document}`];
  const current = await giteaApi("GET", `${file}?ref=${encodeURIComponent(branch)}`);
  if (!current.ok) throw new Error(`Gitea GET ${file} -> ${String(current.status)}`);
  const pushed = await giteaApi("PUT", file, { branch, sha: ((await current.json()) as { sha: string }).sha, message: `label: ${label}`, content: Buffer.from(generated.tsx).toString("base64") });
  if (!pushed.ok) throw new Error(`Gitea PUT ${file} -> ${String(pushed.status)}: ${await pushed.text()}`);
  const note: PushNote = { document, commit: ((await pushed.json()) as { commit: { sha: string } }).commit.sha, label, dropped };
  state.append("pushes.jsonl", note);
  return note;
}

/** How long a push may take to reach the canvas when nobody told the git peer: its reconcile timer (main.ts: 30 s), and slack. */
export const PUSH_BUDGET_MS = 60_000;

/** F16a: an engineer pushes an in-shape change to a shipped page while its document is open. */
export async function engineerPush(): Promise<void> {
  const { owner } = world();
  const document = await newDocument(owner, `push ${randomUUID().slice(0, 8)}`);
  const ledger = openLedger(document, "engineer-push");
  const ann = peerOf(owner, document);
  try {
    await shippedButton(owner, document, ann, ledger);
    const push = await pushLabel(document, ann.confirmed, "Pay now", false);
    const shown = await until(() => labelOn(ann) === push.label, PUSH_BUDGET_MS);
    await sameSeq([ann]);
    keep(ledger.file());
    say(`[engineer_push] ${document}: commit ${push.commit} on the canvas ${String(shown)}`);
  } finally {
    ann.close();
  }
}
