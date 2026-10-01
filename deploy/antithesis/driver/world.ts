// What every driver command stands on: the api as a named user, the stores read DIRECTLY (never through toxiproxy:
// a fault must not blind the judge), and the run's state directory, shared by the commands of one run because each
// is a process of its own (SPEC §4a: the op ledger, so `finally` can account for every submitted op).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Redis } from "ioredis";
import pg from "pg";
import { SessionResponse } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { connectPeer } from "@noon/peer-client";

const need = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set: the driver runs inside the harness (deploy/antithesis/run.sh)`);
  return value;
};
const number = (name: string, fallback: number): number => Number(process.env[name] ?? "") || fallback;

export const config = {
  api: process.env["API_URL"] ?? "http://api:3000",
  state: process.env["HARNESS_STATE"] ?? "/var/antithesis",
  /** The timings compose gave the SUT: what "past the lease" and "stale" mean in this run. */
  leaseTtlMs: number("LEASE_TTL_MS", 10_000),
  staleMs: number("STALE_MS", 15_000),
  stepMs: number("STUB_STEP_MS", 300),
};

export const say = (line: string): void => { process.stdout.write(`${line}\n`); };
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `condition` (never a fixed sleep, SPEC §4a). False: it did not come true within `timeoutMs`. */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number, everyMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await sleep(everyMs);
  }
}
/** The same, for a step the rest of the command cannot go on without. */
export async function must(condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  if (!(await until(condition, timeoutMs))) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for: ${what}`);
}

// --- the run's state: plain files under one directory --------------------------------------------------------------
const dir = (name: string): string => {
  const path = join(config.state, name);
  mkdirSync(path, { recursive: true });
  return path;
};
export const state = {
  write(name: string, value: unknown): void {
    mkdirSync(dirname(join(config.state, name)), { recursive: true });
    writeFileSync(join(config.state, name), `${JSON.stringify(value, null, 1)}\n`);
  },
  read(name: string): unknown {
    const path = join(config.state, name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  },
  /** One JSON line onto a log several processes add to: an append of one short line is not torn. */
  append(name: string, value: unknown): void {
    dir(".");
    appendFileSync(join(config.state, name), `${JSON.stringify(value)}\n`);
  },
  lines<T>(name: string): T[] {
    const path = join(config.state, name);
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
  },
  /** Every file of a subdirectory, parsed: `ledger/` holds one file per (document, process). */
  all<T>(sub: string): T[] {
    const path = dir(sub);
    return readdirSync(path).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(readFileSync(join(path, name), "utf8")) as T);
  },
  text(name: string): string | undefined {
    const path = join(config.state, name);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  },
};

// --- cues: how run.sh (which holds Docker, so it opens the faults) and a scene agree on WHEN ------------------------
// A scene SAYS a line (`@@ burst {...}`) on stdout, which run.sh waits for in the scene's log: the fault is triggered
// off that line, not off a sleep. run.sh answers by making a file, which the scene waits for.
export const cue = {
  say(name: string, details: Record<string, unknown> = {}): void { say(`@@ ${name} ${JSON.stringify(details)}`); },
  heard: (name: string): boolean => existsSync(join(config.state, "cues", name)),
  wait: (name: string, timeoutMs: number): Promise<void> => must(() => cue.heard(name), `run.sh's cue "${name}"`, timeoutMs),
};

// --- the api, as someone -------------------------------------------------------------------------------------------
export type Answer = { status: number; body: unknown };
/** One request as `email` (the development identity header). Never throws on a status: the caller judges it. */
export async function call(email: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${config.api}${path}`, { method, headers: { "x-dev-user": email, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON: an empty 204, or a proxy's words */ }
  return { status: res.status, body: parsed };
}
/** The same, for a step that must work: the body, or an error naming the status. */
export async function ok<T = { id: string }>(email: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const answer = await call(email, method, path, body, headers);
  if (answer.status < 200 || answer.status > 299) throw new Error(`${method} ${path} as ${email} -> ${String(answer.status)} ${JSON.stringify(answer.body)}`);
  return answer.body as T;
}

/** The people of the run (first_setup makes them): two orgs, so that there is a stranger to refuse. */
export type World = {
  org: string; workspace: string;
  /** Emails: the api's development identity. The two ids are what the journal and the share routes name people by. */
  owner: string; editor: string; viewer: string; viewerId: string;
  /** Not in the org: holds a share of one document for a while (revoked-share-loses-access). */
  outsider: string; outsiderId: string;
  /** Owner of ANOTHER org, with a document of their own: the prober of no-cross-org-read. */
  stranger: string; strangerOrg: string; strangerDoc: string;
};
export function world(): World {
  const found = state.read("world.json") as World | undefined;
  if (!found) throw new Error("no world.json: first_setup has not run (run.sh up)");
  return found;
}
export const newDocument = async (as: string, title: string): Promise<string> => {
  const { org, workspace } = world();
  return (await ok(as, "POST", `/orgs/${org}/workspaces/${workspace}/documents`, { title })).id;
};

// --- a peer, through the one write path ---------------------------------------------------------------------------
/** One connection of a peer: when its welcome came, and the lease token its room was opened under (read just after). */
export type Epoch = { liveAt: number; token?: number };
export type DriverPeer = ReturnType<typeof connectPeer> & { /** The sync node this peer last dialled. */ node(): string; /** Its connections so far, oldest first. */ epochs: Epoch[] };
/**
 * `email` in `documentId`, through /session and @noon/peer-client, as a browser tab is. `ackTimeoutMs` is the
 * client's own knob (how long it waits on a silent server): shortened, a frozen owner is noticed inside a run.
 */
export function peerOf(email: string, documentId: string, options: { ackTimeoutMs?: number; onOp?: () => void } = {}): DriverPeer {
  let node = "";
  const epochs: Epoch[] = [];
  const peer = connectPeer({
    manifest,
    onStatus: (status) => {
      if (status !== "live") return;
      const epoch: Epoch = { liveAt: Date.now() };
      epochs.push(epoch);
      void holderOf(documentId).then((holder) => { if (holder) epoch.token = holder.token; }, () => undefined);
    },
    retryMs: { min: 250, max: 2000 },
    ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
    ...(options.onOp === undefined ? {} : { onOp: options.onOp }),
    session: async () => {
      const answer = await call(email, "POST", `/documents/${documentId}/session`);
      if (answer.status === 404) return null; // no access (any more): give up, as a browser does
      const session = SessionResponse.parse(answer.status === 200 ? answer.body : undefined); // anything else throws: "try again later"
      node = new URL(session.wsUrl).hostname;
      return session;
    },
  });
  return Object.assign(peer, { node: () => node, epochs });
}
export const live = (peers: readonly DriverPeer[], what: string, timeoutMs = 20_000): Promise<void> => must(() => peers.every((peer) => peer.status === "live"), what, timeoutMs);

// --- the stores, read directly -----------------------------------------------------------------------------------
let pool: pg.Pool | undefined;
/** Rows of one read as the database OWNER (the app's role cannot read across orgs; the judge must). */
export async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  pool ??= new pg.Pool({ connectionString: need("HARNESS_DATABASE_URL"), max: 4 });
  return (await pool.query<T>(text, values)).rows;
}
let redisClient: Redis | undefined;
export function redis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(need("HARNESS_REDIS_URL"), { maxRetriesPerRequest: 2 });
    redisClient.on("error", () => undefined); // a wipe or a restart is part of the run: the next command retries
  }
  return redisClient;
}
export type Holder = { token: number; node: string };
/** Who holds the document's room: its lease, as Redis itself has it. */
export async function holderOf(documentId: string): Promise<Holder | undefined> {
  const match = /^(\d+):([a-z0-9-]+)$/.exec((await redis().get(`lease:${documentId}`)) ?? "");
  return match?.[1] !== undefined && match[2] !== undefined ? { token: Number(match[1]), node: match[2] } : undefined;
}
export async function closeStores(): Promise<void> {
  await pool?.end();
  redisClient?.disconnect();
}
