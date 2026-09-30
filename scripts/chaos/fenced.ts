// chaos:zombie-fenced and chaos:partition-fenced (E7.3, SPEC F22). Against the REAL compose stack (two sync nodes,
// each reaching Redis through the `redis-proxy` toxiproxy):
//   ./init.sh   (or: docker compose up -d), then   node scripts/chaos/fenced.ts zombie|partition   (ROUNDS=2 by default)
// Each round, on a fresh document: a person and the AI (both routed by /session, as in E7.2) get a few edits
// acknowledged, and a WITNESS, a bare WebSocket that never reconnects, joins the owner's room. Then, under a burst:
//   zombie:    the owner is `docker pause`d past its lease (ttl + 2 s after another node took the room), then resumed;
//   partition: the owner is cut off from Redis ONLY (toxiproxy's timeout toxic: bytes stop, connections stay open,
//              Postgres still answers), for as long, then the cut is healed.
// Either way: the peers must find the other node through /session, the lease must move to it with a larger token,
// the old owner must close its sockets (the witness is dropped, and the old owner logs why) and never append again (every row
// of the journal is one the peers made, once; seqs 1..n, no gap, no duplicate: scripts/chaos/no-loss.ts). Edits made
// AFTER the old owner is back must land too. How many appends the fence itself refused is read from the old owner's
// log and reported (a paused owner usually notices its lost lease first; the fence is for the ones that do not).
// Pitfalls (SPEC §4a): the fault opens while the workload is on the wire; waits poll the observable; it repeats; the
// fault is undone in `finally`. Prints one JSON line; exit 0 = PASS. The org is deleted at the end.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { SessionResponse, type Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";
// Relative, as tests import packages they do not depend on: the root package does not list session-token.
import { signSessionToken } from "../../packages/session-token/src/index.ts";
import { createLedger, noLossViolations } from "./no-loss.ts";

const fault = process.argv[2];
if (fault !== "zombie" && fault !== "partition") throw new Error("usage: node scripts/chaos/fenced.ts zombie|partition");
const name = `${fault}-fenced`;
const api = process.env["API_URL"] ?? "http://localhost:3000";
const toxiproxy = process.env["TOXIPROXY_URL"] ?? `http://localhost:${process.env["TOXIPROXY_PORT"] ?? "8474"}`;
const rounds = Number(process.env["ROUNDS"] ?? "2");
// Only two keys are read from .env: the AI peer's signing key, and the lease ttl compose was started with.
const dotenv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const secretOrNone = process.env["SESSION_TOKEN_SECRET"] ?? dotenv["SESSION_TOKEN_SECRET"];
if (secretOrNone === undefined) throw new Error("SESSION_TOKEN_SECRET is not set and .env has none: run ./init.sh");
const secret: string = secretOrNone;
const ttlMs = Number(process.env["LEASE_TTL_MS"] || dotenv["LEASE_TTL_MS"] || "10000"); // compose: empty = 10 s
const env = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin` };
const compose = (...args: string[]): string => execFileSync("docker", ["compose", ...args], { env, encoding: "utf8" });
const psql = (sql: string): string => compose("exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-tAc", sql).trim();
// Straight to Redis, not through the proxy: the lease as Redis itself holds it.
const holderOf = (documentId: string): { token: number; node: string } | undefined => {
  const match = /^(\d+):([a-z0-9-]+)$/.exec(compose("exec", "-T", "redis", "redis-cli", "--no-auth-warning", "GET", `lease:${documentId}`).trim());
  return match?.[1] && match[2] ? { token: Number(match[1]), node: match[2] } : undefined;
};

// The toxiproxy proxy of a node is named as the node (scripts/chaos/toxiproxy.json). Both directions stop.
const STREAMS = ["upstream", "downstream"] as const;
async function toxics(node: string, cut: boolean): Promise<void> {
  for (const stream of STREAMS) {
    const res = cut
      ? await fetch(`${toxiproxy}/proxies/${node}/toxics`, { method: "POST", body: JSON.stringify({ name: `cut-${stream}`, type: "timeout", stream, toxicity: 1, attributes: { timeout: 0 } }) })
      : await fetch(`${toxiproxy}/proxies/${node}/toxics/cut-${stream}`, { method: "DELETE" });
    if (!res.ok && !(res.status === 404 && !cut)) throw new Error(`toxiproxy ${cut ? "cut" : "heal"} ${node} ${stream} -> ${String(res.status)}`);
  }
}
async function open(node: string): Promise<void> {
  if (fault === "zombie") compose("pause", node);
  else await toxics(node, true);
}
async function undo(node: string): Promise<void> {
  if (fault === "zombie") compose("unpause", node);
  else await toxics(node, false);
}

const email = `chaos-${name}@example.com`;
const headers = { "x-dev-user": email, "content-type": "application/json" };
async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${api}${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`POST ${path} -> ${String(res.status)}`);
  return res.json();
}
const idOf = (created: unknown): string => (created as { id: string }).id;
const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 0, component: "Stack", props: {} });

async function until(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A peer of the owner's room that never reconnects (its session answers once, then "give up") and never waits for
 * anything (so its own silence watchdog never fires): it stops being live only when the old owner closes it.
 */
async function witness(session: () => Promise<{ wsUrl: string; token: string }>): Promise<{ closed: () => boolean; close: () => void }> {
  let asked = false;
  const peer = connectPeer({ manifest, session: async () => { if (asked) return null; asked = true; return session(); } });
  await until(() => peer.status === "live", "the witness joins the owner's room", 15_000);
  return { closed: () => peer.status !== "live", close: () => { peer.close(); } };
}

const org = idOf(await post("/orgs", { name: `chaos ${name}` }));
// The AI peer acts for this person: since E8.2 the room lets in only a member of the org, and an AI run is its creator.
const me = idOf(((await (await fetch(`${api}/auth/me`, { headers })).json()) as { user: unknown }).user);
const workspace = idOf(await post(`/orgs/${org}/workspaces`, { name: "chaos" }));

async function round(n: number): Promise<{ round: number; from: string; to: string; fencedAppends: number; ops: number; journaled: number; violations: string[] }> {
  const doc = idOf(await post(`/orgs/${org}/workspaces/${workspace}/documents`, { title: `chaos ${name} ${String(n)}` }));
  const session = async () => SessionResponse.parse(await post(`/documents/${doc}/session`));
  const peers = {
    person: connectPeer({ manifest, session }),
    ai: connectPeer({ manifest, session: async () => ({ wsUrl: (await session()).wsUrl, token: signSessionToken({ userId: me, orgId: org, documentId: doc, secret, ttlSeconds: 600, actor: { kind: "agent", runId: randomUUID() } }) }) }),
  };
  const all = Object.entries(peers);
  const ledger = createLedger();
  let made = 0;
  let victim: string | undefined;
  let watcher: Awaited<ReturnType<typeof witness>> | undefined;
  const edit = (count: number): void => {
    for (let i = 0; i < count; i++) for (const [who, peer] of all) ledger.track(who, peer.submit(add(`${who}-${String(made++)}`)));
  };
  try {
    await until(() => all.every(([, p]) => p.status === "live"), "both peers live", 15_000);
    edit(5);
    await ledger.settle(10_000); // acknowledged before the fault
    const before = holderOf(doc);
    if (!before) throw new Error(`no sync node holds the lease of ${doc}`);
    victim = before.node;
    watcher = await witness(session);
    const since = new Date().toISOString();

    edit(20); // on the wire...
    await open(victim); // ...and the owner freezes, or loses Redis, under it
    ledger.fault();
    // The burst above is usually ALL acknowledged before the fault bites (`docker pause` blocks this loop while the
    // owner answers), and a peer times only what it waits for: with nothing pending it would never notice a frozen
    // owner. These are made AFTER the fault, so both peers wait on it and their silence watchdog fires.
    edit(3);
    await until(() => all.every(([, p]) => p.status !== "live"), "both peers see the owner gone", 30_000);
    edit(5); // made while the room is moving: held, sent after the next welcome

    let after: ReturnType<typeof holderOf>;
    await until(() => { after = holderOf(doc); return after !== undefined && after.node !== victim; }, "another node takes the room", ttlMs * 2 + 30_000);
    if (!after || after.token <= before.token) throw new Error(`the new owner's token ${String(after?.token)} is not above the old one's ${String(before.token)}`);
    await until(() => all.every(([, p]) => p.status === "live" && p.pendingCount === 0), "both peers reconnected through /session, nothing pending", 30_000);
    // Past its lease for certain, then back: a zombie that still believes it owns the room.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await undo(victim);
    const back = victim;
    victim = undefined;
    await until(() => watcher?.closed() === true, `the old owner ${back} closes its sockets`, ttlMs + 10_000);

    edit(10); // the old owner is running again: none of this may reach it
    await ledger.settle(15_000);
    await until(() => all.every(([, p]) => p.seq === peers.person.seq && p.pendingCount === 0), "both peers at the same seq", 10_000);

    const journal = psql(`select seq || ' ' || op_id from op_journal where document_id = '${doc}' order by seq`)
      .split("\n").filter(Boolean).map((line) => { const [seq, opId] = line.split(" "); return { seq: Number(seq), opId: opId ?? "" }; });
    const docs = all.map(([, p]) => JSON.stringify(p.confirmed));
    const violations = noLossViolations({ ledger: ledger.entries, journal, docs });
    const logs = compose("logs", "--no-color", "--since", since, back);
    const fencedAppends = logs.split("\n").filter((line) => line.includes(doc) && line.includes("fenced by a newer owner")).length;
    // Why the witness was closed: the room was given up (lease lost, or fenced), not a heartbeat or a crash.
    if (!logs.split("\n").some((line) => line.includes(doc) && /lease \d+ (lost|fenced)/.test(line))) violations.push(`the old owner ${back} never logged giving the room up`);
    return { round: n, from: back, to: after.node, fencedAppends, ops: ledger.entries.length, journaled: journal.length, violations };
  } finally {
    watcher?.close();
    for (const [, p] of all) p.close();
    if (victim !== undefined) await undo(victim); // whatever failed above, the fault is undone
  }
}

let verdict = "PASS";
let reason = "";
const results: Awaited<ReturnType<typeof round>>[] = [];
try {
  for (let n = 1; n <= rounds; n++) {
    const result = await round(n);
    results.push(result);
    if (result.violations.length > 0) verdict = "FAIL";
  }
} catch (err) {
  verdict = "FAIL";
  reason = err instanceof Error ? err.message : String(err);
} finally {
  try { psql(`delete from orgs where id = '${org}'; delete from users where email = '${email}'`); } catch { /* reported below */ }
}
process.stdout.write(`${JSON.stringify({ chaos: name, verdict, rounds: results, ...(reason === "" ? {} : { reason }) })}\n`);
process.exit(verdict === "PASS" ? 0 : 1);
