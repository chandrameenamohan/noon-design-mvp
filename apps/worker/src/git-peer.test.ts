import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { GitEvent } from "@noon/db";
import { createGitPeer, type ChangedPage, type PeerStore } from "./git.ts";
import { git, localOrigin, type LocalOrigin } from "./git-testing.ts";
import { pagePath } from "./sandbox.ts";

// noon-wv8.3.1: which commit a push is diffed from. Real git (a local bare repo stands in for Gitea, as in
// git.int.test.ts), an in-memory store in place of Postgres: no Docker, no database.

const DOC = "0f9c7a0e-1b2c-4d3e-8f00-000000000001";
const OTHER = "0f9c7a0e-1b2c-4d3e-8f00-000000000002";
const main = "refs/heads/main";
let local: LocalOrigin | undefined;
afterEach(() => {
  local?.remove();
});

type Row = GitEvent & { status: string; attempt: number };
/** git_events in memory: the same unique key on (branch, commit), claimed oldest first. */
function memoryStore(rows: Row[] = []): PeerStore {
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
