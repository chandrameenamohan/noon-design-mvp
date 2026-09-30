// chaos:kill-sync-no-loss (E6.3, SPEC F18). Against the REAL compose stack:
//   ./init.sh   (or: docker compose up -d), then   node scripts/chaos/kill-sync-no-loss.ts   (ROUNDS=3 by default)
// Each round, on a fresh document: a person (the api's session route) and the AI (a token signed as its worker
// signs it) join through @noon/peer-client and get a few edits acknowledged. Then each fires a burst of edits
// and the sync server is `kill -9`ed at once, so the burst is caught in flight: some journaled with the
// acknowledgement never heard, some never received. More edits are made while the server is gone. The server
// is started again; the PEERS are left alone and must reconnect by themselves. scripts/chaos/no-loss.ts then
// holds the ledger of every edit against the journal (F18: every acknowledged op present, none twice,
// unacknowledged ops resent and applied once, peers converge).
// Pitfalls carried over (SPEC §4a): the fault opens while the workload is on the wire; waits poll the observable,
// never a fixed sleep; one-shot passes prove nothing, so it repeats; sync is started again in `finally`.
// Prints one JSON line; exit 0 = PASS. Cleanup: the org it creates is deleted at the end (cascade).
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
const syncUrl = process.env["SYNC_URL"] ?? "ws://localhost:3001";
const rounds = Number(process.env["ROUNDS"] ?? "3");
// Only the one key the AI peer signs with is read from .env; nothing else leaves that file.
const secretOrNone = process.env["SESSION_TOKEN_SECRET"] ?? (existsSync(".env") ? parseEnv(readFileSync(".env", "utf8"))["SESSION_TOKEN_SECRET"] : undefined);
if (secretOrNone === undefined) throw new Error("SESSION_TOKEN_SECRET is not set and .env has none: run ./init.sh");
const secret: string = secretOrNone; // round() is a function declaration: the narrowing above does not reach into it
const env = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin` };
const compose = (...args: string[]): string => execFileSync("docker", ["compose", ...args], { env, encoding: "utf8" });
const psql = (sql: string): string => compose("exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-tAc", sql).trim();

const email = "chaos-kill-sync@example.com";
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

const org = idOf(await post("/orgs", { name: "chaos kill sync" }));
const workspace = idOf(await post(`/orgs/${org}/workspaces`, { name: "chaos" }));

/** One document, one kill. Returns what broke, in words (empty = PASS), and how much was exercised. */
async function round(n: number): Promise<{ round: number; ops: number; journaled: number; violations: string[] }> {
  const doc = idOf(await post(`/orgs/${org}/workspaces/${workspace}/documents`, { title: `chaos kill sync ${String(n)}` }));
  const wsUrl = `${syncUrl}/documents/${doc}`;
  const peers = {
    person: connectPeer({ manifest, session: async () => SessionResponse.parse(await post(`/documents/${doc}/session`)) }),
    ai: connectPeer({ manifest, session: () => Promise.resolve({ wsUrl, token: signSessionToken({ userId: randomUUID(), orgId: org, documentId: doc, secret, ttlSeconds: 600, actor: { kind: "agent", runId: randomUUID() } }) }) }),
  };
  const all = Object.entries(peers);
  const ledger = createLedger();
  let made = 0;
  const edit = (count: number): void => {
    for (let i = 0; i < count; i++) for (const [name, peer] of all) ledger.track(name, peer.submit(add(`${name}-${String(made++)}`)));
  };
  try {
    await until(() => all.every(([, p]) => p.status === "live"), "both peers live", 15_000);
    edit(5);
    await ledger.settle(10_000); // acknowledged before the fault

    edit(20); // on the wire...
    compose("kill", "--signal", "SIGKILL", "sync"); // ...and the server dies under it. execFileSync: no ack is heard meanwhile.
    ledger.fault();
    await until(() => all.every(([, p]) => p.status !== "live"), "both peers see the server gone", 30_000);
    edit(5); // made while the server is gone: held, sent after the next welcome

    compose("start", "sync");
    await until(() => all.every(([, p]) => p.status === "live" && p.pendingCount === 0), "both peers reconnected unaided, nothing pending", 60_000);
    await ledger.settle(15_000);
    await until(() => all.every(([, p]) => p.seq === peers.person.seq), "both peers at the same seq", 10_000);

    const journal = psql(`select seq || ' ' || op_id from op_journal where document_id = '${doc}' order by seq`)
      .split("\n").filter(Boolean).map((line) => { const [seq, opId] = line.split(" "); return { seq: Number(seq), opId: opId ?? "" }; });
    const docs = all.map(([, p]) => JSON.stringify(p.confirmed));
    return { round: n, ops: ledger.entries.length, journaled: journal.length, violations: noLossViolations({ ledger: ledger.entries, journal, docs }) };
  } finally {
    for (const [, p] of all) p.close();
    compose("start", "sync"); // whatever failed above, the server comes back
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
process.stdout.write(`${JSON.stringify({ chaos: "kill-sync-no-loss", verdict, rounds: results, ...(reason === "" ? {} : { reason }) })}\n`);
process.exit(verdict === "PASS" ? 0 : 1);
