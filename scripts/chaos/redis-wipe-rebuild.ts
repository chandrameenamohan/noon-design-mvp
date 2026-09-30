// chaos:redis-wipe-rebuild (E9.2b, SPEC F28 and §4 "Redis lost"). Against the REAL compose stack:
//   ./init.sh   (or: docker compose up -d), then   node scripts/chaos/redis-wipe-rebuild.ts
// Two rounds, one per way of losing Redis: `flush` (FLUSHALL: every key gone, every connection still open, so
// nobody is told) and `restart` (the container restarts; it has no volume and no AOF on purpose). In each round:
//   - AI runs on the stub worker (scripts/chaos/stub-worker.ts; the compose `worker` is stopped so no model is called):
//     four long runs fill its four slots and are mid-way, three more wait in Redis's `wait` list, and only there;
//   - a room is open: two people editing, acknowledged edits, a burst on the wire, and a WITNESS (a peer that never
//     reconnects) in the owner's room;
// then Redis is wiped under all of it. Afterwards (scripts/chaos/rebuild.ts, scripts/chaos/no-loss.ts judge):
//   - the waiting runs were offered again from Postgres (the worker's sweep) and every run succeeded, claimed ONCE,
//     each step journaled once: no duplicate job, no duplicate op;
//   - the room's owner gave it up (the witness is closed), a node holds the lease again under a larger token (the floor
//     from the journal's fence, E7.3) and the fence names exactly that token: one owner. No acknowledged edit lost or
//     doubled, every peer on the same document.
// Waits poll the observable; the stack is put back in `finally`. Prints one JSON line; exit 0 = PASS. The org is deleted.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SessionResponse, type Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";
import { createLedger, noLossViolations } from "./no-loss.ts";
import { leaseViolations, runViolations, type Holder, type RunAfter } from "./rebuild.ts";

const api = process.env["API_URL"] ?? "http://localhost:3000";
const env = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin` };
const docker = (...args: string[]): string => execFileSync("docker", args, { env, encoding: "utf8" });
const compose = (...args: string[]): string => docker("compose", ...args);
const psql = (sql: string): string => compose("exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-tAc", sql).trim();
// Straight to Redis (its password is in the container's REDISCLI_AUTH), not through the sync nodes' proxy.
const redis = (...args: string[]): string => compose("exec", "-T", "redis", "redis-cli", "--no-auth-warning", ...args).trim();
const holderOf = (documentId: string): Holder | undefined => {
  const match = /^(\d+):([a-z0-9-]+)$/.exec(redis("GET", `lease:${documentId}`));
  return match?.[1] && match[2] ? { token: Number(match[1]), node: match[2] } : undefined;
};
const runId = (): string => /run_id:(\w+)/.exec(redis("INFO", "server"))?.[1] ?? "";

const email = "chaos-redis-wipe@example.com";
const headers = { "x-dev-user": email, "content-type": "application/json" };
async function post(path: string, body?: unknown, extra: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${api}${path}`, { method: "POST", headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`POST ${path} -> ${String(res.status)}`);
  return res.json();
}
const idOf = (created: unknown): string => (created as { id: string }).id;
const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 0, component: "Stack", props: {} });
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const org = idOf(await post("/orgs", { name: "chaos redis wipe" }));
const workspace = idOf(await post(`/orgs/${org}/workspaces`, { name: "chaos" }));
const newDocument = async (title: string): Promise<string> => idOf(await post(`/orgs/${org}/workspaces/${workspace}/documents`, { title }));
const status = (run: string): string => psql(`select status from jobs where id = '${run}'`);
const agentRows = (doc: string): number => Number(psql(`select count(*) from op_journal where document_id = '${doc}' and actor_kind = 'agent'`));

const stubs: string[] = [];
/** A stub AI worker in its own container: the worker image, the compose network and environment, stub-worker.ts. */
async function startStub(): Promise<void> {
  const name = `noon-chaos-stub-worker-${randomUUID().slice(0, 8)}`;
  stubs.push(name);
  compose("run", "--detach", "--no-deps", "--name", name, "--volume", `${process.cwd()}/scripts/chaos/stub-worker.ts:/repo/scripts/chaos/stub-worker.ts:ro`, "worker", "node", "scripts/chaos/stub-worker.ts");
  await until(() => docker("logs", name).includes("stub worker draining queues: ai"), `${name} ready`, 60_000);
}

/** A peer of the owner's room that never reconnects: it stops being live only when that owner closes it. */
async function witness(session: () => Promise<{ wsUrl: string; token: string }>): Promise<{ closed: () => boolean; close: () => void }> {
  let asked = false;
  const peer = connectPeer({ manifest, session: async () => { if (asked) return null; asked = true; return session(); } });
  await until(() => peer.status === "live", "the witness joins the owner's room", 15_000);
  return { closed: () => peer.status !== "live", close: () => { peer.close(); } };
}

type Wipe = "flush" | "restart";
async function wipe(how: Wipe): Promise<void> {
  if (how === "flush") {
    const answer = redis("FLUSHALL");
    if (answer !== "OK") throw new Error(`FLUSHALL answered ${answer}`);
    return;
  }
  const before = runId();
  compose("restart", "redis");
  await until(() => { try { return redis("PING") === "PONG"; } catch { return false; } }, "Redis answers again", 60_000);
  if (runId() === before) throw new Error("Redis did not restart: same run_id");
}

const LONG = 40; // steps, one every 300 ms on the stub: about 12 s, long enough to be mid-way at the wipe
const SHORT = 5;
async function round(how: Wipe): Promise<Record<string, unknown>> {
  // The room.
  const roomDoc = await newDocument(`chaos redis wipe ${how}: room`);
  const session = async () => SessionResponse.parse(await post(`/documents/${roomDoc}/session`));
  const peers = { ann: connectPeer({ manifest, session }), "ann-2nd-tab": connectPeer({ manifest, session }) };
  const all = Object.entries(peers);
  const ledger = createLedger();
  let made = 0;
  const edit = (count: number): void => {
    for (let i = 0; i < count; i++) for (const [who, peer] of all) ledger.track(who, peer.submit(add(`${who}-${String(made++)}`)));
  };
  let watcher: Awaited<ReturnType<typeof witness>> | undefined;
  try {
    await until(() => all.every(([, p]) => p.status === "live"), "both peers live", 15_000);
    edit(5);
    await ledger.settle(10_000);
    const before = holderOf(roomDoc);
    if (!before) throw new Error(`no sync node holds the lease of ${roomDoc}`);
    watcher = await witness(session);

    // The runs: four fill the stub's four slots, three wait behind them in Redis.
    const steps = new Map<string, number>();
    const docOf = new Map<string, string>();
    const start = async (n: number, count: number): Promise<string> => {
      const doc = await newDocument(`chaos redis wipe ${how}: run ${String(n)}`);
      const run = idOf(await post(`/documents/${doc}/runs`, { instruction: `nodes=${String(count)}` }, { "idempotency-key": randomUUID() }));
      steps.set(run, count);
      docOf.set(run, doc);
      return run;
    };
    const long = await Promise.all([1, 2, 3, 4].map((n) => start(n, LONG)));
    await until(() => long.every((run) => agentRows(docOf.get(run) ?? "") >= 3), "the four long runs are mid-way", 60_000);
    await Promise.all([5, 6, 7].map((n) => start(n, SHORT)));
    await until(() => Number(redis("LLEN", "bull:ai:wait")) >= 3, "three runs wait in Redis", 15_000);
    const waitingAtWipe = Number(redis("LLEN", "bull:ai:wait"));
    const runningAtWipe = long.filter((run) => status(run) === "running").length;

    // Edits never touch Redis, so the fault the peers meet is the owner giving the room up at its next renewal (up
    // to a third of a ttl after the wipe): a steady stream keeps edits on the wire until that moment.
    const stream = setInterval(() => { edit(1); }, 50);
    try {
      await wipe(how);
      await until(() => watcher?.closed() === true, "the room's owner gives it up (its lease is gone)", 30_000);
      // The owner drops the room in one go (stop reading, close every socket), and it answers fast, so at that instant
      // the wire is usually empty: what spans the fault is the stream's edits the peers HOLD until the next welcome.
      // Seen closed before the stream's next tick, none was held yet and the run was vacuous (both rounds of one run).
      // Synchronous from here to fault(): no acknowledgement can land between the check and the mark.
      await until(() => all.some(([, p]) => p.pendingCount > 0), "a peer holds an edit across the room's move", 10_000);
      ledger.fault();
    } finally {
      clearInterval(stream);
    }
    edit(5); // made while the room is moving
    await until(() => holderOf(roomDoc) !== undefined && all.every(([, p]) => p.status === "live" && p.pendingCount === 0), "a node holds the room again, both peers live, nothing pending", 60_000);
    edit(5);
    await ledger.settle(15_000);
    await until(() => all.every(([, p]) => p.seq === peers.ann.seq && p.pendingCount === 0), "both peers at the same seq", 10_000);

    await until(() => [...steps.keys()].every((run) => !["queued", "running"].includes(status(run))), "every run ends", 120_000);
    const runs: RunAfter[] = [...steps.keys()].map((run) => {
      const doc = docOf.get(run) ?? "";
      const [st = "", attempts = "0"] = psql(`select status, attempts from jobs where id = '${run}'`).split("|");
      const [ops = "0", opIds = "0", nodes = "0"] = psql(`select count(*), count(distinct op_id), count(distinct op->>'nodeId') from op_journal where run_id = '${run}'`).split("|");
      const [seqs = "0", maxSeq = "0"] = psql(`select count(distinct seq), coalesce(max(seq), 0) from op_journal where document_id = '${doc}'`).split("|");
      return { id: run, status: st, attempts: Number(attempts), ops: Number(ops), opIds: Number(opIds), nodes: Number(nodes), seqs: Number(seqs), maxSeq: Number(maxSeq) };
    });

    const after = holderOf(roomDoc);
    const fenceToken = Number(psql(`select fence_token from documents where id = '${roomDoc}'`));
    const journal = psql(`select seq || ' ' || op_id from op_journal where document_id = '${roomDoc}' order by seq`)
      .split("\n").filter(Boolean).map((line) => { const [seq, opId] = line.split(" "); return { seq: Number(seq), opId: opId ?? "" }; });
    const violations = [
      ...runViolations({ steps, runs, waitingAtWipe, runningAtWipe }),
      ...leaseViolations({ before, after, fenceToken }),
      ...noLossViolations({ ledger: ledger.entries, journal, docs: all.map(([, p]) => JSON.stringify(p.confirmed)) }),
    ];
    return { round: how, waitingAtWipe, runningAtWipe, lease: { before, after }, runs: runs.length, ops: ledger.entries.length, violations };
  } finally {
    watcher?.close();
    for (const [, p] of all) p.close();
  }
}

let verdict = "PASS";
let reason = "";
const rounds: Record<string, unknown>[] = [];
compose("stop", "worker"); // it would take the runs to the real model
try {
  await startStub();
  for (const how of ["flush", "restart"] as const) {
    const result = await round(how);
    rounds.push(result);
    if ((result["violations"] as string[]).length > 0) verdict = "FAIL";
  }
} catch (err) {
  verdict = "FAIL";
  reason = err instanceof Error ? err.message : String(err);
} finally {
  for (const name of stubs) try { docker("rm", "--force", name); } catch { /* already gone */ }
  try { compose("start", "redis", "worker"); } catch { /* reported by the next run's stack check */ }
  try { psql(`delete from orgs where id = '${org}'; delete from users where email = '${email}'`); } catch { /* reported below */ }
}
process.stdout.write(`${JSON.stringify({ chaos: "redis-wipe-rebuild", verdict, rounds, ...(reason === "" ? {} : { reason }) })}\n`);
process.exit(verdict === "PASS" ? 0 : 1);
