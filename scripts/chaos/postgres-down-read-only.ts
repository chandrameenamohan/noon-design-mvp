// chaos:postgres-down-read-only (E6.1b, SPEC §4 "Postgres or MinIO down"). Against the REAL compose stack:
//   ./init.sh   (or: docker compose up -d), then   node scripts/chaos/postgres-down-read-only.ts
// Three peers join one document through @noon/peer-client, one of each kind (a person via the api's session
// route, the AI and the git peer with tokens signed as their workers sign them). Postgres is then taken away,
// twice: STOPPED (connections refused) and PAUSED (queries hang until the room's journal timeout). Each time:
//   - every peer shows read-only, through the contract (status message), and stays connected;
//   - no op is acknowledged while read-only; an op made just before is HELD, never lost;
//   - once Postgres is back, every peer is writable again unaided, the held op lands exactly once, and the
//     journal has no gap and no duplicate seq or opId.
// Pitfalls carried over (SPEC §4a): the fault is opened BEFORE the workload; waits poll the observable, never a
// fixed sleep; Postgres is restored in `finally`, whatever failed. Prints one JSON line; exit 0 = PASS.
// Cleanup: the org it creates is deleted at the end (cascade), as scripts/smoke-sync.ts's caller does.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { SessionResponse, type Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";
// Relative, as tests import packages they do not depend on: the root package does not list session-token.
import { signSessionToken } from "../../packages/session-token/src/index.ts";

const api = process.env["API_URL"] ?? "http://localhost:3000";
const syncUrl = process.env["SYNC_URL"] ?? "ws://localhost:3001";
// Only the one key the AI and git peers sign with is read from .env; nothing else leaves that file.
const secret = process.env["SESSION_TOKEN_SECRET"] ?? (existsSync(".env") ? parseEnv(readFileSync(".env", "utf8"))["SESSION_TOKEN_SECRET"] : undefined);
if (secret === undefined) throw new Error("SESSION_TOKEN_SECRET is not set and .env has none: run ./init.sh");
const env = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin` };
const compose = (...args: string[]): string => execFileSync("docker", ["compose", ...args], { env, encoding: "utf8" });
const psql = (sql: string): string => compose("exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-tAc", sql).trim();

const headers = { "x-dev-user": "chaos-read-only@example.com", "content-type": "application/json" };
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
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`);
}

const org = idOf(await post("/orgs", { name: "chaos read-only" }));
// The AI peer acts for this person: since E8.2 the room lets in only a member of the org, and an AI run is its creator.
const me = idOf(((await (await fetch(`${api}/auth/me`, { headers })).json()) as { user: unknown }).user);
const workspace = idOf(await post(`/orgs/${org}/workspaces`, { name: "chaos" }));
const doc = idOf(await post(`/orgs/${org}/workspaces/${workspace}/documents`, { title: "chaos read-only" }));
const wsUrl = `${syncUrl}/documents/${doc}`;
const signed = (actor: { kind: "agent" | "git"; runId: string }) => () => Promise.resolve({ wsUrl, token: signSessionToken({ userId: me, orgId: org, documentId: doc, secret, ttlSeconds: 600, actor }) });
const peers = {
  person: connectPeer({ manifest, session: async () => SessionResponse.parse(await post(`/documents/${doc}/session`)) }),
  ai: connectPeer({ manifest, session: signed({ kind: "agent", runId: randomUUID() }) }),
  git: connectPeer({ manifest, session: signed({ kind: "git", runId: "c".repeat(40) }) }),
};
const all = Object.values(peers);
const steps: string[] = [];

/** One outage: `down` takes Postgres away, `up` brings it back; `name` names this round and its nodes. */
async function outage(name: string, down: () => void, up: () => void, readOnlyWithinMs: number): Promise<void> {
  const seqBefore = peers.person.seq;
  down(); // the fault first, then the workload (a fast pipeline outruns a late fault)
  try {
    const held = peers.person.submit(add(`held-${name}`));
    check(held.ok, `${name}: the person's edit is accepted locally`);
    await until(() => all.every((p) => p.readOnly), `${name}: every peer shows read-only`, readOnlyWithinMs);
    for (const [who, peer] of [["AI", peers.ai], ["git peer", peers.git]] as const) {
      const tried = peer.submit(add(`${who.replace(" ", "-")}-${name}`));
      check(!tried.ok && tried.reason === "read_only", `${name}: the ${who}'s edit is refused as read_only`);
    }
    check(all.every((p) => p.status === "live"), `${name}: every peer stays connected`);
    check(peers.person.pendingCount === 1 && peers.person.seq === seqBefore, `${name}: the held edit is pending, nothing acknowledged`);
    steps.push(`${name}: read-only on all three peers`);
    up();
    await until(() => all.every((p) => !p.readOnly), `${name}: every peer writable again`, 60_000);
    const outcome = held.ok ? await held.settled : undefined;
    check(outcome?.ok === true && outcome.seq === seqBefore + 1, `${name}: the held edit landed once, at seq ${String(seqBefore + 1)} (got ${JSON.stringify(outcome)})`);
    await until(() => all.every((p) => p.seq === seqBefore + 1), `${name}: every peer at seq ${String(seqBefore + 1)}`, 10_000);
    steps.push(`${name}: recovered, held edit at seq ${String(seqBefore + 1)}`);
  } finally {
    up(); // whatever failed above, Postgres comes back
  }
}

let verdict = "PASS";
let reason = "";
try {
  await until(() => all.every((p) => p.status === "live"), "three peers live", 15_000);
  const first = peers.person.submit(add("before"));
  check(first.ok && (await first.settled).ok, "an edit before any outage is saved");

  // Stopped: connections are refused at once, so read-only follows the first op.
  await outage("stopped", () => compose("stop", "postgres"), () => compose("start", "postgres"), 15_000);
  // Paused: queries hang. The sync server's journal timeout (5 s) turns that into a failure.
  await outage("paused", () => compose("pause", "postgres"), () => { try { compose("unpause", "postgres"); } catch { /* already running */ } }, 20_000);

  // The journal is the truth: every seq once, every opId once, no gap.
  const journal = psql(`select seq || ' ' || op_id from op_journal where document_id = '${doc}' order by seq`).split("\n").filter(Boolean).map((line) => line.split(" "));
  check(journal.map(([seq]) => Number(seq)).join(",") === "1,2,3", `the journal holds seq 1,2,3 exactly (got ${journal.map(([seq]) => seq).join(",")})`);
  check(new Set(journal.map(([, opId]) => opId)).size === journal.length, "no opId is journaled twice");
  const [person, ...others] = all.map((p) => JSON.stringify(p.confirmed));
  check(others.every((each) => each === person), "all three peers hold the same document");
} catch (err) {
  verdict = "FAIL";
  reason = err instanceof Error ? err.message : String(err);
} finally {
  for (const p of all) p.close();
  try { compose("unpause", "postgres"); } catch { /* not paused */ }
  compose("start", "postgres");
  try { psql(`delete from orgs where id = '${org}'; delete from users where email = 'chaos-read-only@example.com'`); } catch { /* reported below */ }
}
process.stdout.write(`${JSON.stringify({ chaos: "postgres-down-read-only", verdict, steps, ...(reason === "" ? {} : { reason }) })}\n`);
process.exit(verdict === "PASS" ? 0 : 1);
