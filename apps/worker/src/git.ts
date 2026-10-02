import { constants, existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitEvent, GitStore } from "@noon/db";
import { describeError } from "@noon/queue";
import { cli, fingerprint, gitEnv, type SeedRepo } from "./sandbox.ts";

/**
 * The git peer's half of E5.3a (the api's webhook is the other door). It keeps a bare mirror of the repo
 * in its own directory (a volume: SPEC §2.15), records every branch that moved in Gitea but has no commit
 * event yet (Gitea never retries a failed delivery), and works through the events one at a time, each
 * in a worktree of its own that is removed however the job ends. What a commit means for a document
 * (ops through peer-client) is E5.3b's (push.ts): this hands it each generated page the commit touched,
 * and on request the page as it was before.
 */

/** A generated page a commit touched. Refused: deleted, not a regular file (a symlink could point anywhere), or over parse's cap. */
export type ChangedPage = { documentId: string; path: string } & ({ tsx: string } | { refused: "deleted" | "not_a_file" | "too_large" });
/** The page before the push, for E5.3b's three-way diff: its text at the base commit (when a regular file within the cap), and every node id it held up to there. */
export type PageBase = { tsx: string | undefined; earlierIds: ReadonlySet<string> };
export type Apply = (event: GitEvent, page: ChangedPage, base: () => Promise<PageBase>) => Promise<unknown>;
/** Thrown by `apply` when the push cannot be applied YET (the document's room is read-only, E6.1b): the event waits, it does not fail. */
export class WaitAgain extends Error {}
/** What the git peer needs of the store. */
export type PeerStore = Pick<GitStore, "record" | "heads" | "lastDone" | "claim" | "heartbeat" | "finish" | "takeReconcileRequest" | "shippedCommit">;
type Moved = { ref: string; before: string; after: string };

const PAGE = /^src\/pages\/noon-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tsx$/u; // sandbox.ts's pagePath
/** codegen's parse cap: a bigger page could only ever be refused, so it is never read. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** The branch names the db stores (git_events.ref's check); another name in the mirror is left alone. */
const BRANCH = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/u;
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/u;
const ZERO = /^0+$/u;
const EVENTS_PER_TICK = 20;
/** Thrown between pages when another peer has resumed this event: this one stops, and writes nothing more. */
class Lost extends Error {}

/**
 * Every node id on an added line of `git log -p -U0` of a page: each id the page ever held was added on
 * some commit. Wider than parse (any quote, a `{"..."}`): an id counted that was not one only refuses more.
 */
export function nodeIdsIn(log: string): Set<string> {
  const ids = new Set<string>();
  for (const line of log.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const match of line.matchAll(/data-node-id\s*=\s*\{?\s*["'`]([A-Za-z0-9_-]{1,64})["'`]/gu)) ids.add(match[1] ?? "");
  }
  return ids;
}

/** The document a path in the repo belongs to, if it is one of our generated pages. */
export const pageDocument = (path: string): string | undefined => PAGE.exec(path)?.[1];

/** `git for-each-ref --format='%(refname) %(objectname)' refs/heads/` as branch -> commit; odd names skipped. */
export function parseHeads(output: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [ref, sha, ...rest] = line.split(" ");
    if (ref !== undefined && sha !== undefined && rest.length === 0 && BRANCH.test(ref) && SHA.test(sha)) heads.set(ref, sha);
  }
  return heads;
}

/** What the reconcile records: every branch whose commit in the mirror is not its newest recorded one. A new branch starts from zeros. */
export function moved(mirror: ReadonlyMap<string, string>, recorded: ReadonlyMap<string, string>): Moved[] {
  return [...mirror].filter(([ref, sha]) => recorded.get(ref) !== sha).map(([ref, after]) => ({ ref, before: recorded.get(ref) ?? "0".repeat(after.length), after }));
}

export type GitPeer = {
  /** Fetches the mirror and records each branch that moved without an event. Resolves with how many it recorded. */
  reconcile(): Promise<number>;
  /** Works on the oldest waiting event. False when there was none, or Gitea (or the document's room) was away and the event went back to wait. */
  processNext(): Promise<boolean>;
  /** Every `pollMs`: reconcile if a document was opened or `reconcileMs` passed, then drain the inbox. One tick at a time. */
  start(options: { pollMs: number; reconcileMs: number; onAlive?: () => void }): Promise<{ stop(): Promise<void> }>;
};

export function createGitPeer({ seed, dir, store, apply, log, timeoutMs = 60_000, staleMs = 15_000, maxResumes = 3, retryMs = 5000 }: {
  seed: SeedRepo;
  /** The peer's own directory: the mirror and the jobs' worktrees. Nothing else may use it. */
  dir: string;
  store: PeerStore;
  apply: Apply;
  log: (message: string) => void;
  /** Each git command's end from outside: a wedged Gitea must not hold the peer for ever. */
  timeoutMs?: number;
  /**
   * noon-91u: an event whose peer has not beaten for this long is resumed by another (the peer beats every third of
   * it), at most `maxResumes` times. ponytail: constants, as the jobs' are (0019); a push applied again is safe.
   */
  staleMs?: number;
  maxResumes?: number;
  /**
   * noon-wv8.3.2: how long an event handed back (Gitea away, the room read-only) is passed by, so the events behind
   * it are worked on and the mirror is not fetched every tick. ponytail: fixed; upgrade: back off per attempt.
   */
  retryMs?: number;
}): GitPeer {
  const mirror = join(dir, `${fingerprint(seed.url)}.git`);
  const worktrees = join(dir, "worktrees");
  const git = async (...args: string[]): Promise<string> =>
    (await cli("git", args, AbortSignal.timeout(timeoutMs), { env: gitEnv(seed), name: `git ${(args[0] === "-C" ? args[2] : args[0]) ?? ""}` })).stdout.toString("utf8");
  const has = (sha: string): Promise<boolean> => git("-C", mirror, "cat-file", "-e", `${sha}^{commit}`).then(() => true, () => false);
  /** Is `ancestor` in `commit`'s history (or `commit` itself)? Both must be in the mirror. */
  const isAncestor = (ancestor: string, commit: string): Promise<boolean> => git("-C", mirror, "merge-base", "--is-ancestor", ancestor, commit).then(() => true, () => false);

  async function fetch(): Promise<void> {
    // "--": a URL is never an option. A clone killed halfway is finished by the next fetch.
    if (existsSync(join(mirror, "HEAD"))) await git("-C", mirror, "fetch", "--quiet", "--prune", "origin");
    else await git("clone", "--quiet", "--mirror", "--", seed.url, mirror);
  }

  async function reconcile(): Promise<number> {
    // Read BEFORE the fetch: a head recorded by then is at or behind the mirror. After it, a webhook landing
    // in between would be ahead of the mirror, and the "move" back to the mirror's tip recorded backwards.
    const recordedHeads = await store.heads();
    await fetch();
    const heads = parseHeads(await git("-C", mirror, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"));
    let recorded = 0;
    for (const event of moved(heads, recordedHeads)) if (await store.record(event)) recorded += 1;
    return recorded;
  }

  /**
   * noon-wv8.3.1: what the push is diffed from. The branch's last applied commit when it is behind `after`: a push
   * whose delivery was lost while a later one's arrived is never recorded (the reconcile finds the tip known), so
   * it is folded into this one. Otherwise (the first event, a force-push past it) `before` when the mirror has it.
   * Undefined: neither (a new branch, a force-push that dropped `before`).
   */
  async function diffBase(event: GitEvent, done: string | undefined): Promise<string | undefined> {
    const from = done !== undefined && (await isAncestor(done, event.after)) ? done : !ZERO.test(event.before) && (await has(event.before)) ? event.before : undefined;
    return from === undefined ? undefined : ((await lastShipped(from, event.after)) ?? from);
  }

  /**
   * noon-wv8.6.4: the newest commit Ship made between `from` and the push's own. Ship's page is what the room held
   * when it read it, so it is where the push is diffed from: a ship whose delivery was lost, folded into a later
   * push, would otherwise replay Ship's values over canvas edits made since. `after` itself is left out (push.ts
   * skips a page Ship made). ponytail: one lookup per first-parent commit, newest first, stopping at the first hit;
   * ceiling: a push of thousands of commits with no ship among them asks thousands of times; upgrade: one `= any($1)`.
   */
  async function lastShipped(from: string, after: string): Promise<string | undefined> {
    const commits = (await git("-C", mirror, "rev-list", "--first-parent", `${from}..${after}`)).split("\n").filter((commit) => commit !== "" && commit !== after);
    for (const commit of commits) if (await store.shippedCommit(commit)) return commit;
    return undefined;
  }

  /**
   * noon-wv8.3.3: the branch was already brought past this push, which moved it FORWARD (from nothing, or from an
   * ancestor of `after`) to a commit the last applied one contains: an old push redelivered by hand after a later one
   * folded it in, or (noon-wv8.3.1.1) two peers on one branch finishing out of order. Applying it would set its pages
   * back. A force-push back to an older commit moved the branch backwards (`before` is not behind `after`): applied.
   */
  async function alreadyApplied(event: GitEvent, done: string | undefined): Promise<boolean> {
    if (done === undefined || !(await isAncestor(event.after, done))) return false;
    return ZERO.test(event.before) || ((await has(event.before)) && (await isAncestor(event.before, event.after)));
  }

  /** The pages the commit touched since `from`, read from the job's worktree; no `from`: every generated page at `after`. */
  async function changedPages(event: GitEvent, from: string | undefined, worktree: string): Promise<ChangedPage[]> {
    const listed = from !== undefined
      ? await git("-C", mirror, "diff", "--name-only", "-z", "--no-renames", from, event.after, "--", "src/pages/")
      : await git("-C", mirror, "ls-tree", "-r", "--name-only", "-z", event.after, "--", "src/pages/");
    const pages: ChangedPage[] = [];
    for (const path of listed.split("\0")) {
      const documentId = pageDocument(path);
      if (documentId !== undefined) pages.push({ documentId, path, ...(await readPage(join(worktree, path))) });
    }
    return pages;
  }

  /**
   * The page as it was before the push: at `from` (diffBase); without one, the tip's first parent, so the push's
   * last commit is the change. None: a root commit.
   * ponytail: a new branch of several commits is taken as its last one; upgrade: its merge-base with main.
   */
  async function baseCommit(event: GitEvent, from: string | undefined): Promise<string | undefined> {
    if (from !== undefined) return from;
    return (await git("-C", mirror, "rev-list", "--parents", "-n", "1", event.after)).trim().split(" ")[1];
  }

  async function pageBase(commit: string | undefined, path: string): Promise<PageBase> {
    if (commit === undefined) return { tsx: undefined, earlierIds: new Set() };
    // "<mode> blob <object> <size>\t<path>": only a regular file within parse's cap is read (a symlink's blob is its target's name).
    const entry = /^100(?:644|755) blob ([0-9a-f]{40,64}) +(\d+)\t/u.exec(await git("-C", mirror, "ls-tree", "-l", "-z", commit, "--", path));
    const tsx = entry?.[1] !== undefined && Number(entry[2]) <= MAX_PAGE_BYTES ? await git("-C", mirror, "cat-file", "blob", entry[1]) : undefined;
    // --full-history: an id added and removed again on a side branch that a merge left out still counts.
    // ponytail: the whole history of one file, held in memory (cli's buffer cap); upgrade: stream it.
    const log = await git("-C", mirror, "log", "--full-history", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "-p", "-U0", "--format=", commit, "--", path);
    return { tsx, earlierIds: nodeIdsIn(log) };
  }

  async function removeWorktree(worktree: string): Promise<void> {
    // Each step on its own: a failed `worktree remove` (the checkout never finished) must still leave nothing.
    await git("-C", mirror, "worktree", "remove", "--force", worktree).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true });
    await git("-C", mirror, "worktree", "prune").catch(() => undefined);
  }

  async function processNext(): Promise<boolean> {
    const event = await store.claim(staleMs, maxResumes);
    if (!event) return false;
    const worktree = join(worktrees, event.id);
    const resumed = new AbortController(); // by another peer, after this one's beats went unseen
    const beat = setInterval(() => {
      void store.heartbeat(event).then((alive) => { if (!alive) resumed.abort(); }, () => undefined); // a missed beat: the next one
    }, Math.max(1, Math.floor(staleMs / 3)));
    try {
      if (!(await has(event.after))) {
        try {
          await fetch();
        } catch (err) {
          // Gitea is away: the event waits again rather than being lost (the reconcile would never re-record it).
          await store.finish(event, "pending", retryMs);
          log(`fetch failed, ${event.ref} ${event.after} waits: ${describeError(err)}`);
          return false;
        }
        // Fetched, and still not there: force-pushed away before we looked. Nothing to apply, ever.
        if (!(await has(event.after))) throw new Error(`commit ${event.after} of ${event.ref} is not in the repo`);
      }
      const lastDone = await store.lastDone(event.ref);
      const done = lastDone !== undefined && (await has(lastDone)) ? lastDone : undefined;
      if (await alreadyApplied(event, done)) {
        await store.finish(event, "skipped");
        log(`${event.ref} ${event.after} skipped: the branch was already applied up to ${done ?? ""}`);
        return true;
      }
      await mkdir(worktrees, { recursive: true });
      await git("-C", mirror, "worktree", "add", "--quiet", "--detach", worktree, event.after);
      const from = await diffBase(event, done);
      let base: Promise<string | undefined> | undefined;
      for (const page of await changedPages(event, from, worktree)) {
        if (resumed.signal.aborted) throw new Lost(`${event.ref} ${event.after}: another peer has resumed it`);
        await apply(event, page, async () => pageBase(await (base ??= baseCommit(event, from)), page.path));
      }
      await store.finish(event, "done");
    } catch (err) {
      if (err instanceof Lost) {
        log(err.message);
        return true;
      }
      if (err instanceof WaitAgain) {
        // ponytail: the whole event waits, pages already applied included (applying again is safe: push-ops takes
        // the commit's journaled adds as its own, noon-91u). Ceiling: one retry per `retryMs` while the room stays read-only.
        await store.finish(event, "pending", retryMs);
        log(`${event.ref} ${event.after} waits: ${err.message}`);
        return false;
      }
      log(`${event.ref} ${event.after} failed: ${describeError(err)}`);
      await store.finish(event, "failed");
    } finally {
      clearInterval(beat);
      await removeWorktree(worktree);
    }
    return true;
  }

  return {
    reconcile,
    processNext,
    async start({ pollMs, reconcileMs, onAlive }) {
      // A worktree left by a peer that was killed mid-job: nothing may outlive its job, not even a crash.
      await rm(worktrees, { recursive: true, force: true });
      if (existsSync(join(mirror, "HEAD"))) await git("-C", mirror, "worktree", "prune").catch(() => undefined);
      let nextReconcile = 0;
      async function tick(): Promise<void> {
        try {
          // Taken BEFORE the fetch: a document opened while it runs asks again, and is not lost.
          if ((await store.takeReconcileRequest()) || Date.now() >= nextReconcile) {
            nextReconcile = Date.now() + reconcileMs;
            await reconcile();
          }
        } catch (err) {
          nextReconcile = Date.now() + Math.min(reconcileMs, 10_000); // Gitea away: again soon, not every tick
          log(`reconcile failed: ${describeError(err)}`);
        }
        try {
          for (let n = 0; n < EVENTS_PER_TICK && (await processNext()); n += 1);
          onAlive?.();
        } catch (err) {
          log(`inbox unreadable: ${describeError(err)}`);
        }
      }
      let running: Promise<void> | undefined;
      const beat = (): void => void (running ??= tick().finally(() => (running = undefined)));
      beat();
      const timer = setInterval(beat, pollMs);
      return {
        async stop() {
          clearInterval(timer);
          await running;
        },
      };
    },
  };
}

/** A page as the job's worktree holds it. O_NOFOLLOW: a pushed symlink named like a page must not read /proc or the worker's files. */
async function readPage(file: string): Promise<{ tsx: string } | { refused: "deleted" | "not_a_file" | "too_large" }> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") return { refused: "deleted" };
    if (code === "ELOOP" || code === "EMLINK") return { refused: "not_a_file" }; // the symlink itself (EMLINK on some BSDs)
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { refused: "not_a_file" }; // a submodule checks out as a directory
    if (stat.size > MAX_PAGE_BYTES) return { refused: "too_large" };
    return { tsx: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}
