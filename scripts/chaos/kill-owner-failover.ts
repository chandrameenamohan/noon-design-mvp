// chaos:kill-owner-failover (E7.2, SPEC F21). Against the REAL compose stack (two sync nodes):
//   ./init.sh   (or: docker compose up -d), then   node scripts/chaos/kill-owner-failover.ts   (ROUNDS=3 by default)
// Each round, on a fresh document: a person (the api's session route) and the AI (a token signed as its worker
// signs it, routed by /session too) join through @noon/peer-client and get a few edits acknowledged. Each fires a
// burst and the sync node that owns the room (read from its lease) is `kill -9`ed under it, as in E6.3. More edits
// are made while it is gone. It is NOT started again: the peers must find the OTHER node through /session by
// themselves, and that node must take the room as soon as the dead lease expires (never more than about one
// LEASE_TTL_MS after the kill). Then scripts/chaos/no-loss.ts, unchanged, holds the ledger against the journal
// (F18: every acknowledged op present, none twice, unacknowledged ops resent and applied once, peers converge).
// Pitfalls (SPEC §4a): the fault opens while the workload is on the wire; waits poll the observable; it repeats;
// the killed node is started again in `finally`. Prints one JSON line; exit 0 = PASS. The org is deleted at the end.
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

const api = process.env["API_URL"] ?? "http://localhost:3000";
const rounds = Number(process.env["ROUNDS"] ?? "3");
// Only two keys are read from .env: the AI peer's signing key, and the lease ttl compose was started with.
const dotenv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const secretOrNone = process.env["SESSION_TOKEN_SECRET"] ?? dotenv["SESSION_TOKEN_SECRET"];
if (secretOrNone === undefined) throw new Error("SESSION_TOKEN_SECRET is not set and .env has none: run ./init.sh");
const secret: string = secretOrNone; // round() is a function declaration: the narrowing above does not reach into it
const ttlMs = Number(process.env["LEASE_TTL_MS"] || dotenv["LEASE_TTL_MS"] || "10000"); // compose: empty = 10 s
// The takeover itself lands within ttl + ttl/10 (takeLease polls every tenth); the rest is docker exec and one
// poll of ours. A takeover that waited out a SECOND ttl (peers bouncing on 4409 until a retry happened to land)
// fails this.
const takeoverBudgetMs = ttlMs + ttlMs / 10 + 2000;
const env = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin` };
const compose = (...args: string[]): string => execFileSync("docker", ["compose", ...args], { env, encoding: "utf8" });
const psql = (sql: string): string => compose("exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-tAc", sql).trim();
// The room's owner, "<token>:<node id>" in its lease; undefined while nobody holds it. (The container has
// REDISCLI_AUTH for its healthcheck, so no password passes through here.)
const holderOf = (documentId: string): { token: number; node: string } | undefined => {
  const match = /^(\d+):([a-z0-9-]+)$/.exec(compose("exec", "-T", "redis", "redis-cli", "--no-auth-warning", "GET", `lease:${documentId}`).trim());
  return match?.[1] && match[2] ? { token: Number(match[1]), node: match[2] } : undefined;
};

const email = "chaos-kill-owner@example.com";
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

const org = idOf(await post("/orgs", { name: "chaos kill owner" }));
// The AI peer acts for this person: since E8.2 the room lets in only a member of the org, and an AI run is its creator.
const me = idOf(((await (await fetch(`${api}/auth/me`, { headers })).json()) as { user: unknown }).user);
const workspace = idOf(await post(`/orgs/${org}/workspaces`, { name: "chaos" }));

/** One document, one kill, no restart. Returns what broke, in words (empty = PASS), and how much was exercised. */
async function round(n: number): Promise<{ round: number; from: string; to: string; movedAfterMs: number; ops: number; journaled: number; violations: string[] }> {
  const doc = idOf(await post(`/orgs/${org}/workspaces/${workspace}/documents`, { title: `chaos kill owner ${String(n)}` }));
  const session = async () => SessionResponse.parse(await post(`/documents/${doc}/session`));
  const peers = {
    person: connectPeer({ manifest, session }),
    // /session's address with the worker's kind of token: after the kill it too must be sent to the live node.
    ai: connectPeer({ manifest, session: async () => ({ wsUrl: (await session()).wsUrl, token: signSessionToken({ userId: me, orgId: org, documentId: doc, secret, ttlSeconds: 600, actor: { kind: "agent", runId: randomUUID() } }) }) }),
  };
  const all = Object.entries(peers);
  const ledger = createLedger();
  let made = 0;
  let victim: string | undefined;
  const edit = (count: number): void => {
    for (let i = 0; i < count; i++) for (const [name, peer] of all) ledger.track(name, peer.submit(add(`${name}-${String(made++)}`)));
  };
  try {
    await until(() => all.every(([, p]) => p.status === "live"), "both peers live", 15_000);
    edit(5);
    await ledger.settle(10_000); // acknowledged before the fault

    const before = holderOf(doc);
    if (!before) throw new Error(`no sync node holds the lease of ${doc}`);
    victim = before.node;
    edit(20); // on the wire...
    compose("kill", "--signal", "SIGKILL", victim); // ...and the owner dies under it. execFileSync: no ack is heard meanwhile.
    const killedAt = Date.now();
    ledger.fault();
    await until(() => all.every(([, p]) => p.status !== "live"), "both peers see the owner gone", 30_000);
    edit(5); // made while no node has the room: held, sent after the next welcome

    let after: ReturnType<typeof holderOf>;
    await until(() => { after = holderOf(doc); return after !== undefined && after.node !== victim; }, `another node takes the room (budget ${String(takeoverBudgetMs)} ms)`, takeoverBudgetMs + 30_000);
    const movedAfterMs = Date.now() - killedAt;
    if (!after || after.token <= before.token) throw new Error(`the new owner's token ${String(after?.token)} is not above the dead one's ${String(before.token)}`);
    await until(() => all.every(([, p]) => p.status === "live" && p.pendingCount === 0), "both peers reconnected through /session, nothing pending", 30_000);
    await ledger.settle(15_000);
    await until(() => all.every(([, p]) => p.seq === peers.person.seq), "both peers at the same seq", 10_000);

    const journal = psql(`select seq || ' ' || op_id from op_journal where document_id = '${doc}' order by seq`)
      .split("\n").filter(Boolean).map((line) => { const [seq, opId] = line.split(" "); return { seq: Number(seq), opId: opId ?? "" }; });
    const docs = all.map(([, p]) => JSON.stringify(p.confirmed));
    const violations = noLossViolations({ ledger: ledger.entries, journal, docs });
    if (movedAfterMs > takeoverBudgetMs) violations.push(`the room moved ${String(movedAfterMs)} ms after the kill: more than one lease ttl (${String(ttlMs)} ms) plus slack`);
    return { round: n, from: victim, to: after.node, movedAfterMs, ops: ledger.entries.length, journaled: journal.length, violations };
  } finally {
    for (const [, p] of all) p.close();
    if (victim !== undefined) compose("start", victim); // back for the next round, whatever failed above
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
process.stdout.write(`${JSON.stringify({ chaos: "kill-owner-failover", verdict, rounds: results, ...(reason === "" ? {} : { reason }) })}\n`);
process.exit(verdict === "PASS" ? 0 : 1);
