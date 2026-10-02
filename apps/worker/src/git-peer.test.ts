import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { GitEvent } from "@noon/db";
import { createGitPeer, type ChangedPage, type PeerStore } from "./git.ts";
import { git, localOrigin, type LocalOrigin } from "./git-testing.ts";
import { pagePath } from "./sandbox.ts";

// noon-wv8.3.1: which commit a push is diffed from. Real git (a local bare repo stands in for Gitea, as in
// git.int.test.ts), an in-memory store in place of Postgres: no Docker, no database.
// Each test spawns real git dozens of times (clone, commits, pushes, a mirror): a second alone, past vitest's 5 s
// under a loaded `make check` (it timed out in a clean clone). The assertions are untouched; only the clock is honest.
vi.setConfig({ testTimeout: 30_000 });

const DOC = "0f9c7a0e-1b2c-4d3e-8f00-000000000001";
const OTHER = "0f9c7a0e-1b2c-4d3e-8f00-000000000002";
const main = "refs/heads/main";
let local: LocalOrigin | undefined;
afterEach(() => {
  local?.remove();
});

type Row = GitEvent & { status: string; attempt: number };
/** git_events in memory: the same unique key on (branch, commit), claimed oldest first. `shipped`: ship_commits. */
function memoryStore(rows: Row[] = [], shipped: ReadonlySet<string> = new Set()): PeerStore {
  return {
    record(e) {
      if (rows.some((r) => r.ref === e.ref && r.after === e.after)) return Promise.resolve(false);
      rows.push({ id: String(rows.length), ref: e.ref, before: e.before, after: e.after, status: "pending", attempt: 0 });
      return Promise.resolve(true);
    },
    heads: () => Promise.resolve(new Map(rows.map((r) => [r.ref, r.after]))),
    lastDone: (ref) => Promise.resolve(rows.filter((r) => r.ref === ref && r.status === "done").at(-1)?.after),
    claim() {
      const row = rows.find((r) => r.status === "pending");
      if (row) Object.assign(row, { status: "running", attempt: row.attempt + 1 });
      return Promise.resolve(row && { ...row });
    },
    heartbeat: () => Promise.resolve(true),
    finish({ id }, status) {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = status;
      return Promise.resolve();
    },
    takeReconcileRequest: () => Promise.resolve(false),
    shippedCommit: (sha) => Promise.resolve(shipped.has(sha)),
  };
}

async function setUp(store: PeerStore = memoryStore()) {
  local = await localOrigin("noon-git-base-");
  const seen: { page: ChangedPage; base: string | undefined }[] = [];
  const peer = createGitPeer({
    seed: { url: local.origin },
    dir: join(local.root, "peer"),
    store,
    apply: async (_event, page, base) => {
      seen.push({ page, base: (await base()).tsx });
    },
    log: () => undefined,
  });
  await peer.reconcile(); // the peer's first look: main (the seed) is new to it
  while (await peer.processNext());
  return { origin: local, store, peer, seen };
}

test("a push whose delivery was lost, followed by a delivered one, is folded into it: its page still reaches apply", async () => {
  const { origin, store, peer, seen } = await setUp();
  const lost = await origin.commit({ [pagePath(DOC)]: "v1\n" }, "the delivery of this one was lost", "main");
  const delivered = await origin.commit({ [pagePath(OTHER)]: "w1\n" }, "this one's arrived", "main");
  expect(await store.record({ ref: main, before: lost, after: delivered, deliveryId: "d" })).toBe(true); // the webhook
  expect(await peer.reconcile()).toBe(0); // the mirror's tip is recorded: the reconcile has nothing to add
  expect(await peer.processNext()).toBe(true);
  expect(seen.map((s) => s.page).sort((a, b) => a.documentId.localeCompare(b.documentId))).toEqual([
    { documentId: DOC, path: pagePath(DOC), tsx: "v1\n" },
    { documentId: OTHER, path: pagePath(OTHER), tsx: "w1\n" },
  ]);
  // The base is where the branch was last applied, not the event's `before`: the lost push's page is new there.
  expect(seen.find((s) => s.page.documentId === DOC)?.base).toBeUndefined();
});

test("a force-push that dropped the last applied commit is diffed from its own `before`, as it always was", async () => {
  const { origin, store, peer, seen } = await setUp();
  const applied = await origin.commit({ [pagePath(DOC)]: "v1\n" }, "applied", "main");
  await store.record({ ref: main, before: await git(origin.work, "rev-parse", "HEAD~1"), after: applied });
  while (await peer.processNext());
  seen.length = 0;
  await git(origin.work, "reset", "--quiet", "--hard", "HEAD~1");
  const rewritten = await origin.commit({ [pagePath(OTHER)]: "w1\n" }, "history rewritten", "main", true);
  const middle = await origin.commit({ [pagePath(OTHER)]: "w2\n" }, "and on", "main");
  await store.record({ ref: main, before: rewritten, after: middle });
  await peer.processNext();
  // `applied` is not an ancestor of `middle`: the diff is rewritten..middle, so DOC (dropped by the force-push) is not in it.
  expect(seen).toEqual([{ page: { documentId: OTHER, path: pagePath(OTHER), tsx: "w2\n" }, base: "w1\n" }]);
});

test("the reconcile reads what is recorded BEFORE it fetches: a webhook landing meanwhile never makes it record a push backwards", async () => {
  const rows: Row[] = [];
  const inner = memoryStore(rows);
  let webhookLands: (() => Promise<void>) | undefined;
  const store: PeerStore = {
    ...inner,
    async heads() {
      await webhookLands?.(); // a push, and its delivery, between the reconcile's fetch and its read (were it that way round)
      webhookLands = undefined;
      return inner.heads();
    },
  };
  const { origin, peer } = await setUp(store);
  const first = await origin.commit({ "a.txt": "1\n" }, "one", "main");
  webhookLands = async () => {
    await inner.record({ ref: main, before: first, after: await origin.commit({ "a.txt": "2\n" }, "two", "main"), deliveryId: "d" });
  };
  await peer.reconcile();
  // Never { before: two, after: one }: working it would apply two..one, reverting the canvas.
  for (const r of rows.slice(1)) expect(await git(origin.work, "merge-base", "--is-ancestor", r.before, r.after).then(() => true, () => false), `${r.before}..${r.after}`).toBe(true);
});

test("noon-wv8.3.3: an old push redelivered after a later one folded it in is skipped, and the next push is still diffed from the later one", async () => {
  const rows: Row[] = [];
  const { origin, store, peer, seen } = await setUp(memoryStore(rows));
  const seed = await git(origin.work, "rev-parse", "HEAD");
  const missed = await origin.commit({ [pagePath(DOC)]: "v1\n" }, "its delivery was lost", "main");
  const later = await origin.commit({ [pagePath(DOC)]: "v2\n" }, "delivered", "main");
  await store.record({ ref: main, before: missed, after: later, deliveryId: "d2" });
  while (await peer.processNext());
  seen.length = 0;
  // An operator redelivers the lost push from Gitea's UI: a new row, for a commit the canvas is already past.
  expect(await store.record({ ref: main, before: seed, after: missed, deliveryId: "d1" })).toBe(true);
  expect(await peer.processNext()).toBe(true);
  expect(seen).toEqual([]); // DOC is not set back to v1
  expect(rows.find((r) => r.after === missed)?.status).toBe("skipped");
  const next = await origin.commit({ [pagePath(DOC)]: "v3\n" }, "and on", "main");
  await store.record({ ref: main, before: later, after: next });
  await peer.processNext();
  expect(seen).toEqual([{ page: { documentId: DOC, path: pagePath(DOC), tsx: "v3\n" }, base: "v2\n" }]);
});

test("noon-wv8.3.1.1: two peers on one branch, the newer push finished first: the older one is skipped, not applied over it", async () => {
  const rows: Row[] = [];
  const shared = memoryStore(rows);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // P1 claims the older event, then stalls (a slow host) until P2 has worked and finished the newer one.
  const slow: PeerStore = { ...shared, lastDone: async (ref) => { await gate; return shared.lastDone(ref); } };
  const { origin, store, seen } = await setUp(shared);
  const seed = await git(origin.work, "rev-parse", "HEAD");
  const older = await origin.commit({ [pagePath(DOC)]: "v1\n" }, "one", "main");
  const newer = await origin.commit({ [pagePath(DOC)]: "v2\n" }, "two", "main");
  await store.record({ ref: main, before: seed, after: older });
  await store.record({ ref: main, before: older, after: newer });
  const peerOf = (name: string, peerStore: PeerStore) => createGitPeer({
    seed: { url: origin.origin }, dir: join(origin.root, name), store: peerStore, log: () => undefined,
    apply: async (_event, page, base) => { seen.push({ page, base: (await base()).tsx }); },
  });
  const p1 = peerOf("p1", slow).processNext();
  await vi.waitFor(() => { expect(rows.find((r) => r.after === older)?.status).toBe("running"); });
  expect(await peerOf("p2", shared).processNext()).toBe(true);
  release();
  expect(await p1).toBe(true);
  expect(seen.map((s) => s.page)).toEqual([{ documentId: DOC, path: pagePath(DOC), tsx: "v2\n" }]); // never v1 after v2
  expect(rows.find((r) => r.after === older)?.status).toBe("skipped");
});

test("noon-wv8.6.4: a push folding in a ship whose delivery was lost is diffed from Ship's commit, so Ship's page is not replayed onto the room", async () => {
  const shipped = new Set<string>();
  const { origin, store, peer, seen } = await setUp(memoryStore([], shipped));
  const applied = await origin.commit({ [pagePath(DOC)]: "v1\n" }, "applied", "main");
  await store.record({ ref: main, before: await git(origin.work, "rev-parse", "HEAD~1"), after: applied });
  while (await peer.processNext());
  seen.length = 0;
  const ship = await origin.commit({ [pagePath(DOC)]: "shipped\n" }, "Ship: its webhook never arrived", "main");
  shipped.add(ship);
  const pushed = await origin.commit({ [pagePath(DOC)]: "v3\n" }, "an engineer's push, delivered", "main");
  await store.record({ ref: main, before: ship, after: pushed });
  await peer.processNext();
  expect(seen).toEqual([{ page: { documentId: DOC, path: pagePath(DOC), tsx: "v3\n" }, base: "shipped\n" }]); // not v1
});

test("noon-wv8.3.3: a force-push back to an older commit is still applied (it moved the branch backwards, on purpose)", async () => {
  const { origin, store, peer, seen } = await setUp();
  const older = await origin.commit({ [pagePath(DOC)]: "v1\n" }, "one", "main");
  const newer = await origin.commit({ [pagePath(DOC)]: "v2\n" }, "two", "main");
  await store.record({ ref: main, before: older, after: newer });
  while (await peer.processNext());
  seen.length = 0;
  await git(origin.work, "push", "--quiet", "--force", "origin", `${older}:refs/heads/main`);
  await store.record({ ref: main, before: newer, after: older });
  await peer.processNext();
  expect(seen).toEqual([{ page: { documentId: DOC, path: pagePath(DOC), tsx: "v1\n" }, base: "v2\n" }]);
});
