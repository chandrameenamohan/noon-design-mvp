import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { GitEvent } from "@noon/db";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { createGitPeer, type Apply, type ChangedPage } from "./git.ts";
import { exec, git, localOrigin } from "./git-testing.ts";
import { pagePath } from "./sandbox.ts";

// E5.3a: integration:missed-webhook-reconciled and integration:worktree-cleaned. Real Postgres, real git.
// The "Gitea" is a local bare repo (the peer fetches a path as it fetches a URL, as sandbox-testing.ts does):
// no webhook is ever delivered here, which is exactly the missed delivery.

const DOC = "0f9c7a0e-1b2c-4d3e-8f00-000000000001";
const OTHER = "0f9c7a0e-1b2c-4d3e-8f00-000000000002";
let t: TestDb;
let root: string;
let origin: string;
let work: string;
let dir: string;
let commitOn: (files: Record<string, string>, message: string, branch: string) => Promise<string>;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.rawQuery("delete from git_events");
  const local = await localOrigin("noon-git-peer-");
  ({ root, origin, work } = local);
  commitOn = local.commit;
  dir = join(root, "peer");
  return local.remove;
});

/** What an engineer does: commit and push, to main unless told otherwise. */
const commit = (files: Record<string, string>, message: string, branch = "main"): Promise<string> => commitOn(files, message, branch);

function peer(apply: Apply = () => Promise.resolve()) {
  const logs: string[] = [];
  return { logs, peer: createGitPeer({ seed: { url: origin }, dir, store: t.db.gitStore(), apply, log: (m) => logs.push(m) }) };
}
const collect = (): { seen: { event: GitEvent; page: ChangedPage }[]; apply: Apply } => {
  const seen: { event: GitEvent; page: ChangedPage }[] = [];
  return { seen, apply: (event, page) => { seen.push({ event, page }); return Promise.resolve(); } };
};
const events = async (): Promise<{ ref: string; before_sha: string; after_sha: string; delivery_id: string | null; status: string }[]> =>
  ((await t.rawQuery("select ref, before_sha, after_sha, delivery_id, status from git_events order by created_at, after_sha")) as { rows: [] }).rows;

/** Every worktree the mirror knows, from git's own porcelain records: only the bare mirror itself may remain. */
async function worktreesLeft(): Promise<{ records: string[][]; dirs: string[] }> {
  const mirror = readdirSync(dir).find((name) => name.endsWith(".git")) ?? "";
  const porcelain = await git(join(dir, mirror), "worktree", "list", "--porcelain");
  const records = porcelain.split("\n\n").map((record) => record.split("\n"));
  const dirs = existsSync(join(dir, "worktrees")) ? readdirSync(join(dir, "worktrees")) : [];
  return { records, dirs };
}
const onlyTheMirror = (left: { records: string[][]; dirs: string[] }): void => {
  expect(left.records).toHaveLength(1);
  expect(left.records[0]).toContain("bare");
  expect(left.dirs).toEqual([]);
};

// --- integration:missed-webhook-reconciled --------------------------------------------------------------

test("a push nobody told us about is recorded by the reconcile, once, and its page reaches apply", async () => {
  const { seen, apply } = collect();
  const { peer: p } = peer(apply);
  const seed = await git(work, "rev-parse", "HEAD");
  // The peer's first look: main is new to it.
  expect(await p.reconcile()).toBe(1);
  expect(await events()).toEqual([{ ref: "refs/heads/main", before_sha: "0".repeat(40), after_sha: seed, delivery_id: null, status: "pending" }]);
  expect(await p.processNext()).toBe(true);

  const pushed = await commit({ [pagePath(DOC)]: "export function Page() { return null; }\n", "src/other.ts": "x\n" }, "edit the page");
  expect(await p.reconcile()).toBe(1);
  expect(await p.reconcile()).toBe(0); // nothing moved since: nothing more
  expect((await events()).at(-1)).toMatchObject({ ref: "refs/heads/main", before_sha: seed, after_sha: pushed, delivery_id: null, status: "pending" });

  expect(await p.processNext()).toBe(true);
  expect(seen).toEqual([{ event: expect.objectContaining({ ref: "refs/heads/main", before: seed, after: pushed }) as GitEvent, page: { documentId: DOC, path: pagePath(DOC), tsx: "export function Page() { return null; }\n" } }]);
  expect((await events()).map((e) => e.status)).toEqual(["done", "done"]);
  expect(await p.processNext()).toBe(false);
});

test("the webhook and the reconcile meet at one event for one push, whichever is first", async () => {
  const { peer: p } = peer();
  await p.reconcile();
  const before = await git(work, "rev-parse", "HEAD");
  const first = await commit({ "a.txt": "1\n" }, "one");
  // The webhook was first: the reconcile finds main already where it is.
  expect(await t.db.gitStore().record({ ref: "refs/heads/main", before, after: first, deliveryId: "d-1" })).toBe(true);
  expect(await p.reconcile()).toBe(0);
  // The reconcile was first: the late webhook is a duplicate.
  const second = await commit({ "a.txt": "2\n" }, "two");
  expect(await p.reconcile()).toBe(1);
  expect(await t.db.gitStore().record({ ref: "refs/heads/main", before: first, after: second, deliveryId: "d-2" })).toBe(false);
  expect((await events()).filter((e) => e.after_sha === first || e.after_sha === second)).toHaveLength(2);
});

test("a new branch, which the webhook ignores as it ignores the registration push, is found by the reconcile", async () => {
  const { seen, apply } = collect();
  const { peer: p } = peer(apply);
  await p.reconcile();
  while (await p.processNext());
  const tip = await commit({ [pagePath(OTHER)]: "export function Page() { return null; }\n" }, "branch", `noon/${OTHER}`);
  expect(await p.reconcile()).toBe(1);
  expect((await events()).at(-1)).toMatchObject({ ref: `refs/heads/noon/${OTHER}`, before_sha: "0".repeat(40), after_sha: tip });
  await p.processNext();
  expect(seen.map((s) => s.page.documentId)).toEqual([OTHER]); // no `before`: every generated page at the tip
});

test("running, the peer reconciles when a document is opened, and on its timer", async () => {
  const { peer: p } = peer();
  await p.reconcile();
  await t.db.gitStore().takeReconcileRequest();
  // A timer that would not fire during this test: only the open can make it look.
  const running = await p.start({ pollMs: 50, reconcileMs: 3_600_000 });
  try {
    await sleep(300); // the first tick reconciles; let it pass
    const opened = await commit({ "b.txt": "1\n" }, "while nobody listened");
    await sleep(300);
    expect((await events()).some((e) => e.after_sha === opened)).toBe(false); // no webhook, no open, no timer: not yet
    await t.db.gitStore().requestReconcile(); // what POST /documents/:id/session does
    await expect.poll(async () => (await events()).find((e) => e.after_sha === opened)?.status, { timeout: 5000 }).toBe("done");
  } finally {
    await running.stop();
  }
  const timed = peer().peer;
  const again = await timed.start({ pollMs: 50, reconcileMs: 200 });
  try {
    const pushed = await commit({ "b.txt": "2\n" }, "the timer finds this");
    await expect.poll(async () => (await events()).find((e) => e.after_sha === pushed)?.status, { timeout: 5000 }).toBe("done");
  } finally {
    await again.stop();
  }
});

test("while Gitea is away an event waits instead of being lost, and is worked on once it is back", async () => {
  const { seen, apply } = collect();
  const { peer: p, logs } = peer(apply);
  await p.reconcile();
  while (await p.processNext());
  const moved = join(root, "away.git");
  const pushed = await commit({ [pagePath(DOC)]: "v2\n" }, "pushed, then Gitea went down");
  await t.db.gitStore().record({ ref: "refs/heads/main", before: await git(work, "rev-parse", "HEAD~1"), after: pushed, deliveryId: "d" });
  await exec("mv", [origin, moved]);
  expect(await p.processNext()).toBe(false);
  expect((await events()).at(-1)?.status).toBe("pending");
  expect(logs.join("\n")).toMatch(/fetch failed/);
  await exec("mv", [moved, origin]);
  expect(await p.processNext()).toBe(true);
  expect(seen.map((s) => s.page)).toEqual([{ documentId: DOC, path: pagePath(DOC), tsx: "v2\n" }]);
});

// --- integration:worktree-cleaned ---------------------------------------------------------------------

test("each job's worktree is gone when it ends: after success, after apply throws, after a missing commit", async () => {
  let checkedOut: string[] = [];
  const { peer: p } = peer(async (_event, page) => {
    checkedOut = readdirSync(join(dir, "worktrees")); // the job really had its own worktree
    if ("tsx" in page && page.tsx.includes("boom")) throw new Error("apply failed");
    await Promise.resolve();
  });
  await p.reconcile();
  while (await p.processNext());

  await commit({ [pagePath(DOC)]: "fine\n" }, "ok");
  await p.reconcile();
  await p.processNext();
  expect(checkedOut).toHaveLength(1);
  onlyTheMirror(await worktreesLeft());

  await commit({ [pagePath(DOC)]: "boom\n" }, "apply throws");
  await p.reconcile();
  await p.processNext();
  expect((await events()).at(-1)?.status).toBe("failed");
  onlyTheMirror(await worktreesLeft());

  // Recorded, then force-pushed away before the peer looked: no checkout, nothing left, the event fails by name.
  await t.db.gitStore().record({ ref: "refs/heads/main", before: await git(work, "rev-parse", "HEAD"), after: "e".repeat(40), deliveryId: "gone" });
  await p.processNext();
  expect((await events()).find((e) => e.delivery_id === "gone")?.status).toBe("failed");
  onlyTheMirror(await worktreesLeft());
});

test("a worktree left by a peer killed mid-job is removed when the next one starts", async () => {
  const { peer: p } = peer();
  await p.reconcile();
  while (await p.processNext());
  const mirror = join(dir, readdirSync(dir).find((name) => name.endsWith(".git")) ?? "");
  await git(mirror, "worktree", "add", "--quiet", "--detach", join(dir, "worktrees", "crashed"), "main");
  expect((await worktreesLeft()).records).toHaveLength(2);
  const running = await p.start({ pollMs: 3_600_000, reconcileMs: 3_600_000 });
  await running.stop();
  onlyTheMirror(await worktreesLeft());
});

test("a pushed symlink named like a page is refused, never followed out of the worktree", async () => {
  const { seen, apply } = collect();
  const { peer: p } = peer(apply);
  await p.reconcile();
  while (await p.processNext());
  writeFileSync(join(root, "secret"), "the worker's secrets\n");
  mkdirSync(join(work, "src/pages"), { recursive: true });
  symlinkSync(join(root, "secret"), join(work, pagePath(DOC)));
  await commit({}, "symlink");
  await commit({ [pagePath(OTHER)]: "" }, "and a real one");
  await p.reconcile();
  while (await p.processNext());
  expect(seen.map((s) => s.page).sort((a, b) => a.documentId.localeCompare(b.documentId))).toEqual([
    { documentId: DOC, path: pagePath(DOC), refused: "not_a_file" },
    { documentId: OTHER, path: pagePath(OTHER), tsx: "" },
  ]);
  onlyTheMirror(await worktreesLeft());
});
