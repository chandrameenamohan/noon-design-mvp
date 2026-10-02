import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { generate } from "@noon/codegen";
import type { Doc, Manifest, ShipOutput } from "@noon/contracts";
import type { Job } from "@noon/db";
import { readingPeer, whenLive, type SyncSessions } from "./live.ts";
import { cli, gitEnv, pagePath, type SeedRepo } from "./sandbox.ts";
import { JobFailure } from "./worker.ts";

/**
 * The `ship` queue's handler (F17, SPEC §8 step 9): the document's page, generated afresh from the room's
 * CONFIRMED document, becomes one commit on the document's working branch (`noon/<id>`, the branch its sandbox
 * works on) in Gitea, and that branch has one open pull request into main. Shipping again adds a commit to the
 * same branch, so the same pull request shows it; a branch that already holds the page as generated gets no
 * commit at all.
 *
 * The commit is built from git objects alone (a bare repo per job, a temporary index): no checkout, nothing
 * of the customer's repo ever runs here. It goes on top of whatever the branch holds, an engineer's commits and
 * an out-of-shape page included (the conflict banner does not stop a ship; the fresh page is the fix).
 *
 * Two ships of one document may run at once (0011_ship_jobs.sql says why). Neither loses: a push that is not on
 * top of the branch is refused by git, and the loser builds again on the winner; Gitea keeps one open pull
 * request per branch (409), and the loser finds it by `head.ref`.
 *
 * The Gitea token stays in THIS process: git gets it as a header in the environment (gitEnv), the API as a
 * header; never in a URL, an argument, a log line or the job's row.
 */

/** A push refused because the branch moved (a racing ship, an engineer's push): built again this many times in all. */
const PUSH_ATTEMPTS = 3;
const IDENTITY = { GIT_AUTHOR_NAME: "Noon", GIT_AUTHOR_EMAIL: "ship@noon.invalid", GIT_COMMITTER_NAME: "Noon", GIT_COMMITTER_EMAIL: "ship@noon.invalid" };
/** Gitea's default MAX_RESPONSE_ITEMS: a longer page is cut to this anyway. */
const PULLS_PER_PAGE = 50;
const MAX_PULL_PAGES = 20;

/** The Gitea API of the repo a clone URL names: http://gitea:3000/noon/sample-app.git -> http://gitea:3000/api/v1/repos/noon/sample-app. */
export function repoApi(cloneUrl: string): string {
  const url = URL.canParse(cloneUrl) ? new URL(cloneUrl) : undefined;
  const path = url && ["http:", "https:"].includes(url.protocol) ? /^(.*)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url.pathname) : null;
  if (!url || !path) throw new Error("the seed repo is not an http(s) Gitea clone URL of the form <host>/<owner>/<repo>.git");
  return `${url.origin}${path[1] ?? ""}/api/v1/repos/${path[2] ?? ""}/${path[3] ?? ""}`;
}

const Pull = z.object({ number: z.number().int().positive(), html_url: z.url({ protocol: /^https?$/u }), state: z.string(), head: z.object({ ref: z.string() }) });
type ShippedPull = NonNullable<ShipOutput["pr"]>;
const pullOf = (pull: z.infer<typeof Pull>): ShippedPull => ({ number: pull.number, url: pull.html_url });

/** The open pull request of `branch` in one page of Gitea's `GET /pulls` answer, if it is there. */
export function openPullOf(page: unknown, branch: string): ShippedPull | undefined {
  const found = z.array(Pull).parse(page).find((pull) => pull.state === "open" && pull.head.ref === branch);
  return found && pullOf(found);
}

/**
 * Did git refuse the push because the branch is not where we built on? Either git saw it (not a fast-forward) or
 * Gitea did, at its ref lock, when the branch was created or moved after git's ref advertisement (two first ships
 * at once both push a create; the loser's is "reference already exists"). Anything else is a real failure.
 */
export const pushRejected = (err: unknown): boolean =>
  /\[rejected\]|non-fast-forward|\(fetch first\)|cannot lock ref '[^']*': (?:reference already exists|is at [0-9a-f]+ but expected)/u.test(err instanceof Error ? err.message : String(err));

/** `git ls-remote` as ref -> commit. */
export function remoteHeads(output: string): Map<string, string> {
  return new Map(output.split("\n").flatMap((line): [string, string][] => {
    const [sha, ref, ...rest] = line.split("\t");
    return sha !== undefined && ref !== undefined && rest.length === 0 && /^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha) ? [[ref, sha]] : [];
  }));
}

/**
 * Puts `tsx` as the document's page on its branch in `seed`, on top of the branch (or of main, for its first
 * ship). `recordCommit` is told the new commit BEFORE it is pushed: the git peer, seeing the push, must already
 * know the commit is Ship's (push.ts skips it). Resolves with that commit, or null when the branch already held
 * the page exactly (nothing to commit).
 */
export async function shipPage({ seed, documentId, tsx, signal, recordCommit, timeoutMs = 60_000 }: {
  seed: SeedRepo; documentId: string; tsx: string; signal: AbortSignal;
  recordCommit: (commit: string) => Promise<void>;
  /** Each git command's end from outside: a wedged Gitea must not hold the job for ever. */
  timeoutMs?: number;
}): Promise<string | null> {
  const branch = `refs/heads/noon/${documentId}`;
  const repo = await mkdtemp(join(tmpdir(), "noon-ship-"));
  const env = { ...gitEnv(seed), ...IDENTITY, GIT_INDEX_FILE: join(repo, "ship-index") };
  const git = async (args: string[], input?: string): Promise<string> =>
    (await cli("git", ["-C", repo, ...args], AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), { env, name: `git ${args[0] ?? ""}`, ...(input === undefined ? {} : { input }) })).stdout.toString("utf8").trim();
  /** Gitea's side: away or refusing is a failure the user reads by name; git's own words go to the log. */
  const remote = (args: string[]): Promise<string> => git(args).catch((err: unknown) => {
    if (pushRejected(err)) throw err;
    throw new JobFailure("gitea_unavailable", err instanceof Error ? err.message : String(err));
  });
  try {
    await git(["init", "--quiet", "--bare"]);
    for (let attempt = 1; ; attempt += 1) {
      // "--": a URL is never an option.
      const heads = remoteHeads(await remote(["ls-remote", "--", seed.url, "refs/heads/main", branch]));
      const onBranch = heads.has(branch);
      if (!onBranch && !heads.has("refs/heads/main")) throw new JobFailure("no_main_branch");
      await remote(["fetch", "--quiet", "--no-tags", "--", seed.url, `+${onBranch ? branch : "refs/heads/main"}:refs/ship/parent`]);
      const parent = await git(["rev-parse", "--verify", "refs/ship/parent^{commit}"]);
      // The parent's tree with the one file the document owns (keystone 8) replaced: nothing else changes.
      await git(["read-tree", parent]);
      const blob = await git(["hash-object", "-w", "--stdin"], tsx);
      await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${pagePath(documentId)}`]);
      const tree = await git(["write-tree"]);
      if (onBranch && tree === (await git(["rev-parse", `${parent}^{tree}`]))) return null;
      const commit = await git(["commit-tree", tree, "-p", parent, "-m", `Ship the page of document ${documentId}\n\nGenerated by Noon from the document; the file is its codegen, byte for byte.`]);
      await recordCommit(commit);
      try {
        // Never forced: a branch that moved since the fetch refuses this, and nothing on it is lost.
        await remote(["push", "--", seed.url, `${commit}:${branch}`]);
        return commit;
      } catch (err) {
        if (!pushRejected(err)) throw err;
        if (attempt >= PUSH_ATTEMPTS) throw new JobFailure("branch_busy", err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/**
 * Per document, the pull request call in flight in this process. Gitea's "one open pull request per branch" is a
 * look-then-insert on its side, not a constraint: two creates at the same instant could both pass it. So the
 * ships of one document ask one at a time. ponytail: one ship worker (compose runs one); ceiling: a second
 * process could still race Gitea; upgrade: a Postgres advisory lock per document around this call.
 */
const pullsInFlight = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (pullsInFlight.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  pullsInFlight.set(key, next);
  const forget = (): void => { if (pullsInFlight.get(key) === next) pullsInFlight.delete(key); };
  next.then(forget, forget);
  return next;
}

/** The branch's open pull request into main: opened, or, when Gitea says one exists (409), found by `head.ref`. */
export async function ensurePull({ seed, documentId, signal, fetchImpl = fetch, timeoutMs = 30_000 }: {
  seed: SeedRepo; documentId: string; signal: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<ShippedPull> {
  const api = repoApi(seed.url);
  const branch = `noon/${documentId}`;
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    try {
      return await fetchImpl(`${api}${path}`, {
        method,
        // `redirect: "error"`: the token is for Gitea, and never follows a redirect anywhere else.
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: { "content-type": "application/json", ...(seed.auth ? { authorization: `token ${seed.auth.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JobFailure("gitea_unavailable", `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const opened = await call("POST", "/pulls", { head: branch, base: "main", title: `Noon: the page of document ${documentId}`, body: `Generated by Noon. \`${pagePath(documentId)}\` is the document's codegen, byte for byte; each ship adds a commit here.` });
  if (opened.status === 201) return pullOf(Pull.parse(await opened.json()));
  if (opened.status !== 409) throw new JobFailure("gitea_unavailable", `POST /pulls -> ${String(opened.status)}`);
  for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
    const listed = await call("GET", `/pulls?state=open&limit=${String(PULLS_PER_PAGE)}&page=${String(page)}`);
    if (!listed.ok) throw new JobFailure("gitea_unavailable", `GET /pulls -> ${String(listed.status)}`);
    const items: unknown = await listed.json();
    const found = openPullOf(items, branch);
    if (found) return found;
    if (!Array.isArray(items) || items.length < PULLS_PER_PAGE) break;
  }
  // ponytail: more than MAX_PULL_PAGES pages of open pull requests is not searched; upgrade: Gitea's head filter.
  throw new JobFailure("gitea_unavailable", "Gitea says the branch has a pull request, and none is open");
}

export function createShipHandler({ sessions, manifest, seed, stopping, stillMember, report, connectTimeoutMs = 10_000, fetchImpl }: {
  sessions: SyncSessions;
  manifest: Manifest;
  seed: SeedRepo;
  /** Aborted when the worker is told to stop (SIGTERM). */
  stopping: AbortSignal;
  /** Asked when the job STARTS, which may be long after it was created. */
  stillMember: (documentId: string, userId: string) => Promise<boolean>;
  /** Writes the job's output (jobs.output): what the canvas shows. Each commit also goes into ship_commits, which the git peer skips, whichever attempt made it (noon-91u). */
  report: (job: Job & { attempt?: number }, output: ShipOutput) => Promise<void>;
  connectTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}): (job: Job & { attempt?: number }, cancelled: AbortSignal) => Promise<undefined> {
  /** The room's CONFIRMED document: never the optimistic one, never a copy in Postgres that may be behind the room. */
  async function readDocument(job: Job, userId: string): Promise<Doc> {
    const peer = readingPeer(job, userId, sessions, manifest); // for the person who pressed Ship
    try {
      await whenLive(peer, connectTimeoutMs).catch((err: unknown) => { throw new JobFailure("sync_unreachable", err instanceof Error ? err.message : String(err)); });
      return peer.confirmed;
    } finally {
      peer.close();
    }
  }

  return async (job, cancelled) => {
    const userId = job.createdBy;
    if (userId === undefined || !(await stillMember(job.documentId, userId))) throw new JobFailure("owner_missing");
    const signal = AbortSignal.any([cancelled, stopping]);
    try {
      const generated = generate(await readDocument(job, userId), manifest);
      if (!generated.ok) throw new JobFailure("codegen_failed", generated.reason);
      const commit = await shipPage({ seed, documentId: job.documentId, tsx: generated.tsx, signal, recordCommit: (made) => report(job, { commit: made, pr: null }) });
      const pr = await oneAtATime(job.documentId, () => ensurePull({ seed, documentId: job.documentId, signal, ...(fetchImpl ? { fetchImpl } : {}) }));
      await report(job, { commit, pr });
      return undefined;
    } catch (err) {
      // A stopping worker names why, as an AI run does; a cancel ends as cancelled (the worker says so).
      if (stopping.aborted) throw new JobFailure("worker_stopped");
      throw err;
    }
  };
}
