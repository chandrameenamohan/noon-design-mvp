// chaos:kill-worker-resumes (E9.2a, SPEC F28 and §4 "worker dies"). Against the REAL compose stack:
//   ./init.sh   (or: docker compose up -d), then   node scripts/chaos/kill-worker-resumes.ts
// Three rounds, one per kind of job, each ending with a `kill -9` of the worker in the middle of it:
//   ai:      a run of 20 steps on the stub worker (scripts/chaos/stub-worker.ts: the real worker and AI handler, a
//            scripted agent; the compose `worker` is stopped meanwhile so no model is ever called). Killed after a
//            few steps: the row stays `running` (nobody said anything), no edit arrives while it is dead, a second
//            stub worker takes it once its heartbeat is stale, and it SUCCEEDS as attempt 2 with the document holding
//            each of the 20 nodes exactly once and the journal every op once.
//   sandbox: a document open with its preview up; worker-sandbox is killed and started again: the preview's job is
//            taken again (attempt 2) and the canvas's preview comes back, instead of the document being blocked for
//            ever (the E4.2b finding).
//   ship:    Gitea is paused first, so the ship is held `running` on its first git call (unheld, a ship ends sooner
//            than one poll here notices it run, noon-elo.2.1); worker-ship is killed while it runs, Gitea resumed, the
//            worker started again: the ship ends `succeeded` as attempt 2 and Gitea has exactly ONE open pull request
//            for the document (Ship's own idempotence, E5.5). ponytail: the kill lands before the commit, never between
//            the push and the pull request; that retry (the branch already holds the page, the PR is opened on it) is
//            the "Ship again" case of apps/worker/src/ship.int.test.ts. Upgrade: a hook in the worker to stop after the push.
// Waits poll the observable, never a fixed sleep; every service is started again in `finally`. Prints one JSON line;
// exit 0 = PASS. Cleanup: the org (cascade), the stub containers, the ship's branch in Gitea.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { Preview, SessionResponse, type Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";

const api = process.env["API_URL"] ?? "http://localhost:3000";
const gitea = `http://127.0.0.1:${process.env["GITEA_PORT"] ?? "3002"}/api/v1/repos/noon/sample-app`;
// Only the one key the ship round needs is read from .env (to COUNT pull requests); nothing else leaves that file.
const giteaToken = process.env["GITEA_TOKEN"] ?? (existsSync(".env") ? parseEnv(readFileSync(".env", "utf8"))["GITEA_TOKEN"] : undefined);
const env = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin` };
const docker = (...args: string[]): string => execFileSync("docker", args, { env, encoding: "utf8" });
const compose = (...args: string[]): string => docker("compose", ...args);
const psql = (sql: string): string => compose("exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-tAc", sql).trim();
const STALE_MS = 15_000; // worker.ts's default: a retry sooner than this after the last beat took a live job

const email = "chaos-kill-worker@example.com";
const headers = { "x-dev-user": email, "content-type": "application/json" };
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${api}${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${String(res.status)}`);
  return res.json();
}
const idOf = (created: unknown): string => (created as { id: string }).id;
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`);
}
/** The job's row. Times are Postgres's (ms since the epoch, 0 = none): compared with each other, never with this host's clock. */
const job = (id: string): { status: string; attempts: number; heartbeat: number; started: number } => {
  const [status = "", attempts = "0", heartbeat = "0", started = "0"] = psql(
    `select status, attempts, coalesce(extract(epoch from heartbeat_at) * 1000, 0)::bigint, coalesce(extract(epoch from started_at) * 1000, 0)::bigint from jobs where id = '${id}'`,
  ).split("|");
  return { status, attempts: Number(attempts), heartbeat: Number(heartbeat), started: Number(started) };
};

const org = idOf(await call("POST", "/orgs", { name: "chaos kill worker" }));
const workspace = idOf(await call("POST", `/orgs/${org}/workspaces`, { name: "chaos" }));
const newDocument = async (title: string): Promise<string> => idOf(await call("POST", `/orgs/${org}/workspaces/${workspace}/documents`, { title }));
/** A person with the document open: live, and present (a pointer), as the canvas is. */
function person(doc: string): ReturnType<typeof connectPeer> {
  const peer = connectPeer({ manifest, session: async () => SessionResponse.parse(await call("POST", `/documents/${doc}/session`)) });
  peer.setPresence({ cursor: { x: 0.5, y: 0.5 }, selection: null });
  return peer;
}

const stubs: string[] = [];
/** A stub AI worker in its own container: the worker image, the compose network and environment, this repo's stub-worker.ts. */
async function startStub(): Promise<string> {
  const name = `noon-chaos-stub-worker-${randomUUID().slice(0, 8)}`;
  stubs.push(name);
  compose("run", "--detach", "--no-deps", "--name", name, "--volume", `${process.cwd()}/scripts/chaos/stub-worker.ts:/repo/scripts/chaos/stub-worker.ts:ro`, "worker", "node", "scripts/chaos/stub-worker.ts");
  await until(() => docker("logs", name).includes("stub worker draining queues: ai"), `${name} ready`, 60_000);
  return name;
}

async function aiRound(): Promise<Record<string, unknown>> {
  const doc = await newDocument("chaos kill worker: ai");
  const steps = 20;
  const agentRows = (): number => Number(psql(`select count(*) from op_journal where document_id = '${doc}' and actor_kind = 'agent'`));
  compose("stop", "worker"); // it would take the run to the real model
  try {
    const first = await startStub();
    const run = idOf(await call("POST", `/documents/${doc}/runs`, { instruction: `nodes=${String(steps)}` }, { "idempotency-key": randomUUID() }));
    await until(() => agentRows() >= 5, "the run is mid-way (5 steps journaled)", 60_000);
    docker("kill", "--signal", "SIGKILL", first);
    const atKill = job(run);
    const journaledAtKill = agentRows();
    check(atKill.status === "running" && atKill.attempts === 1, `a killed worker leaves its job running as attempt 1 (got ${JSON.stringify(atKill)})`);
    check(journaledAtKill < steps, `killed mid-run: ${String(journaledAtKill)} of ${String(steps)} steps done`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    check(agentRows() === journaledAtKill && job(run).status === "running", "nothing moves while no worker is alive");

    await startStub();
    await until(() => !["queued", "running"].includes(job(run).status), "the retried job ends", STALE_MS + 90_000);
    const done = job(run);
    check(done.status === "succeeded" && done.attempts === 2, `the job completes as attempt 2 (got ${JSON.stringify(done)})`);
    // The second attempt started after the first one's last beat had gone stale, not before: a live job is never taken.
    const retriedAfterMs = done.started - atKill.heartbeat;
    check(retriedAfterMs >= STALE_MS, `retried ${String(retriedAfterMs)} ms after the last heartbeat, which is not stale yet`);

    // No duplicate ops: every step's node once, every op once, the room's numbering whole.
    const [ops = "0", opIds = "0", nodes = "0", seqs = "0", maxSeq = "0"] = psql(
      `select count(*), count(distinct op_id), count(distinct op->>'nodeId'), count(distinct seq), coalesce(max(seq), 0) from op_journal where document_id = '${doc}' and actor_kind = 'agent' and run_id = '${run}'`,
    ).split("|");
    check(Number(ops) === steps && Number(opIds) === steps && Number(nodes) === steps, `the journal holds ${String(steps)} add_node ops, each op and each node once (got ops=${ops} opIds=${opIds} nodes=${nodes})`);
    check(Number(seqs) === Number(maxSeq) && Number(maxSeq) === steps, `seq 1..${String(steps)} with no gap (got ${seqs} distinct, max ${maxSeq})`);
    const room = person(doc);
    try {
      await until(() => room.status === "live", "a person opens the document", 15_000);
      const stacks = Object.values(room.confirmed.nodes).filter((n) => n.component === "Stack").length;
      check(stacks === steps, `the document holds ${String(steps)} Stacks (got ${String(stacks)})`);
    } finally {
      room.close();
    }
    return { round: "ai", steps, journaledAtKill, retriedAfterMs };
  } finally {
    compose("start", "worker");
  }
}

async function sandboxRound(): Promise<Record<string, unknown>> {
  const doc = await newDocument("chaos kill worker: sandbox");
  const viewer = person(doc);
  const preview = async (): Promise<Preview> => Preview.parse(await call("GET", `/documents/${doc}/preview`));
  try {
    await until(() => viewer.status === "live", "the person is live", 15_000);
    await call("POST", `/documents/${doc}/preview`);
    await until(async () => (await preview()).url !== null, "the preview is up", 180_000);
    const id = psql(`select id from jobs where document_id = '${doc}' and queue = 'sandbox' and status = 'running'`);
    compose("kill", "--signal", "SIGKILL", "worker-sandbox");
    check(job(id).status === "running" && job(id).attempts === 1, "the killed sandbox worker leaves its job running");
    compose("start", "worker-sandbox");
    await until(async () => job(id).attempts === 2 && job(id).status === "running" && (await preview()).url !== null, "the preview comes back as attempt 2", STALE_MS + 120_000);
    return { round: "sandbox", preview: "back" };
  } finally {
    viewer.close();
    compose("start", "worker-sandbox");
  }
}

async function shipRound(): Promise<Record<string, unknown>> {
  if (giteaToken === undefined) throw new Error("GITEA_TOKEN is not set and .env has none: run ./init.sh");
  const doc = await newDocument("chaos kill worker: ship");
  const branch = `noon/${doc}`;
  const editor = person(doc);
  let giteaPaused = false;
  try {
    await until(() => editor.status === "live", "the person is live", 15_000);
    const add: Op = { type: "add_node", nodeId: "b1", parentId: "root", index: 0, component: "Button", props: { label: "Pay" } };
    const edit = editor.submit(add);
    check(edit.ok && (await edit.settled).ok, "the page has a Button");
    compose("pause", "gitea"); // the ship's git calls hang (each up to 60 s: ship.ts), so it is still running when killed
    giteaPaused = true;
    const ship = idOf(await call("POST", `/documents/${doc}/ship`, undefined, { "idempotency-key": randomUUID() }));
    await until(() => job(ship).status !== "queued", "the ship starts", 60_000);
    const atKill = job(ship);
    compose("kill", "--signal", "SIGKILL", "worker-ship");
    check(atKill.status === "running" && atKill.attempts === 1, `the kill lands mid-ship, attempt 1 running (got ${JSON.stringify(atKill)})`);
    compose("unpause", "gitea");
    giteaPaused = false;
    compose("start", "worker-ship");
    await until(() => !["queued", "running"].includes(job(ship).status), "the ship ends", STALE_MS + 90_000);
    const done = job(ship);
    check(done.status === "succeeded" && done.attempts === 2, `the killed ship is retried and succeeds as attempt 2 (got ${JSON.stringify(done)})`);
    const pulls = (await (await fetch(`${gitea}/pulls?state=open&limit=50`, { headers: { authorization: `token ${giteaToken}` } })).json()) as { head: { ref: string } }[];
    const ours = pulls.filter((p) => p.head.ref === branch).length;
    check(ours === 1, `exactly one open pull request for ${branch} (got ${String(ours)})`);
    return { round: "ship", killedMidShip: true, attempts: done.attempts };
  } finally {
    editor.close();
    if (giteaPaused) compose("unpause", "gitea");
    compose("start", "worker-ship");
    await fetch(`${gitea}/branches/${encodeURIComponent(branch)}`, { method: "DELETE", headers: { authorization: `token ${giteaToken}` } }).catch(() => undefined);
  }
}

let verdict = "PASS";
let reason = "";
const rounds: Record<string, unknown>[] = [];
try {
  rounds.push(await aiRound());
  rounds.push(await sandboxRound());
  rounds.push(await shipRound());
} catch (err) {
  verdict = "FAIL";
  reason = err instanceof Error ? err.message : String(err);
} finally {
  for (const name of stubs) try { docker("rm", "--force", name); } catch { /* already gone */ }
  try { psql(`delete from orgs where id = '${org}'; delete from users where email = '${email}'`); } catch { /* reported below */ }
}
process.stdout.write(`${JSON.stringify({ chaos: "kill-worker-resumes", verdict, rounds, ...(reason === "" ? {} : { reason }) })}\n`);
process.exit(verdict === "PASS" ? 0 : 1);
