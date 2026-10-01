import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOp, emptyDoc } from "@noon/doc-model";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { connect, TEST_SECRET, useSyncServer, type TestPeer } from "../../sync/src/testing.ts";
import { createGitPeer } from "./git.ts";
import { fileOf, localOrigin, type LocalOrigin } from "./git-testing.ts";
import { createPushApplier, type PushOutcome } from "./push.ts";
import { pagePath } from "./sandbox.ts";

// noon-91u, integration:git-event-resume-after-kill. A git peer dies halfway through a push (some of its ops are in
// the room, the rest never sent, its event left `running`); once its heartbeat is stale another peer resumes the
// event and finishes the page: nothing added twice, nothing refused as a re-used id, and a canvas edit made in
// between is not undone. Real git (a local bare repo for Gitea), real Postgres (inbox AND journal), the REAL sync
// server and peer-client. The "kill" is a peer whose heartbeats write nothing and whose socket stops sending ops:
// to Postgres and to the room, exactly what a kill -9 leaves behind.

// Long enough that the dead peer's three ops and the canvas edit fit inside it on a loaded machine: at 1 s the
// survivor found the event stale already (a clean clone's `make check`), and "not before it is stale" could not be seen.
const STALE_MS = 5000;
let t: TestDb;
let local: LocalOrigin;
let document: { id: string; orgId: string };
let person: TestPeer;
let doc: Doc;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());
// With the journal, in Postgres: read when the server starts (its beforeAll runs after the one above).
const ctx = useSyncServer({ get store() { return t.db.documentStore(); } });
beforeEach(async () => {
  await t.rawQuery("delete from git_events");
  local = await localOrigin("noon-git-resume-");
  document = await t.createDocument("Resume");
  person = await connect(ctx.server.url, document.id, undefined, {}, document.orgId);
  await person.next("welcome");
  doc = emptyDoc();
  return () => {
    person.close();
    local.remove();
  };
});

/** A git peer of its own directory. `diesAfter`: its socket sends that many ops and no more, and it never beats. */
function gitPeer(name: string, diesAfter?: number) {
  const outcomes: PushOutcome[] = [];
  let forwarded = 0;
  class Dying extends WebSocket {
    override send(frame: Parameters<WebSocket["send"]>[0]): void {
      if (typeof frame === "string" && frame.includes('"type":"op"') && forwarded++ >= (diesAfter ?? Infinity)) return;
      super.send(frame);
    }
  }
  const store = t.db.gitStore();
  const toOps = createPushApplier({
    sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest,
    documentOrg: (id) => Promise.resolve(id === document.id ? document.orgId : undefined),
    shippedCommit: (sha) => store.shippedCommit(sha),
    pushedNodeIds: (id, sha) => store.pushedNodeIds(id, sha),
    ...(diesAfter === undefined ? {} : { WebSocketImpl: Dying, settleTimeoutMs: 8000 }),
  });
  const peer = createGitPeer({
    seed: { url: local.origin }, dir: join(local.root, name), log: () => undefined, staleMs: STALE_MS,
    store: diesAfter === undefined ? store : { ...store, heartbeat: () => Promise.resolve(true) }, // dead: no beat reaches Postgres
    apply: async (event, page, base) => { outcomes.push(await toOps(event, page, base)); },
  });
  return { peer, outcomes };
}

/** What the person does on the canvas, op by op, each once the room has taken it. */
async function onCanvas(...ops: Op[]): Promise<void> {
  for (const op of ops) {
    const sent = person.send(op);
    await person.next("op", (m) => m.opId === sent);
    doc = applyOp(doc, op);
  }
}
const button = (nodeId: string, label: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 99, component: "Button", props: { label } });
const setLabel = (nodeId: string, value: string): Op => ({ type: "set_prop", nodeId, key: "label", value });
const gitOps = (): unknown[] => person.inbox.filter((m) => m.type === "op" && m.actor.kind === "git");
const eventRow = async (sha: string) =>
  ((await t.rawQuery("select status, attempts, resumes from git_events where after_sha = $1", [sha])) as { rows: [{ status: string; attempts: number; resumes: number }] }).rows[0];
/** The document as the room holds it now: a fresh peer's welcome. */
async function roomDoc(): Promise<Doc> {
  const reader = await connect(ctx.server.url, document.id, undefined, {}, document.orgId);
  try {
    return (await reader.next("welcome")).doc;
  } finally {
    reader.close();
  }
}

test("git-event-resume-after-kill: a push left half-applied by a dead git peer is finished by another, once, and a canvas edit made meanwhile stays", async () => {
  const survivor = gitPeer("survivor");
  const branch = `noon/${document.id}`;
  await onCanvas(button("b1", "Pay"), button("b2", "Cancel"));
  await local.commit({ [pagePath(document.id)]: fileOf(doc) }, "the page as it is", branch, true);
  await survivor.peer.reconcile();
  while (await survivor.peer.processNext());
  expect(survivor.outcomes).toEqual([{ kind: "applied", ops: 0, refused: 0 }]);

  // The engineer's push: four ops, in this order: add b3, add b4, b1's label, remove b2.
  const pushed = [button("b3", "New"), button("b4", "Newer"), setLabel("b1", "From git"), { type: "remove_node", nodeId: "b2" }] satisfies Op[];
  const sha = await local.commit({ [pagePath(document.id)]: fileOf(pushed.reduce(applyOp, doc)) }, "the engineer's edit", branch, true);
  await survivor.peer.reconcile();

  // The peer that dies: three of the four ops reach the room, then nothing more, from its socket or to Postgres.
  const dead = gitPeer("dead", 3);
  const claimedAfter = Date.now();
  const dying = dead.peer.processNext();
  await vi.waitFor(() => { expect(gitOps()).toHaveLength(3); }, { timeout: 10_000, interval: 50 });
  expect(await eventRow(sha)).toMatchObject({ status: "running", attempts: 1, resumes: 0 });
  // Meanwhile, on the canvas: b1 renamed again, after the push's rename landed.
  await onCanvas(setLabel("b1", "Renamed on the canvas"));

  // Not before the dead peer's heartbeat is stale: a live peer's event is never taken.
  expect(await survivor.peer.processNext()).toBe(false);
  await vi.waitFor(async () => { expect(await survivor.peer.processNext()).toBe(true); }, { timeout: 15_000, interval: 50 }); // resumed
  expect(Date.now() - claimedAfter).toBeGreaterThanOrEqual(STALE_MS); // counted from before the dead peer's claim, its only heartbeat
  expect(await eventRow(sha)).toEqual({ status: "done", attempts: 2, resumes: 1 });
  expect(survivor.outcomes.at(-1)).toMatchObject({ kind: "applied" });

  // Finished: the pushed page, except b1's label, which the canvas changed after the push had set it.
  const now = await roomDoc();
  expect(now.nodes["root"]?.children).toEqual(["b1", "b3", "b4"]);
  expect(now.nodes["b1"]?.props).toEqual({ label: "Renamed on the canvas" });
  // Once each: the adds the dead peer made are not made again, nor refused as re-used ids.
  const added = ((await t.rawQuery("select op ->> 'nodeId' as id from op_journal where document_id = $1 and actor_kind = 'git' and op ->> 'type' = 'add_node' order by seq", [document.id])) as { rows: { id: string }[] }).rows;
  expect(added.map((r) => r.id)).toEqual(["b3", "b4"]);
  const git = ((await t.rawQuery("select op ->> 'type' as type from op_journal where document_id = $1 and actor_kind = 'git' order by seq", [document.id])) as { rows: { type: string }[] }).rows;
  expect(git.map((r) => r.type)).toEqual(["add_node", "add_node", "set_prop", "remove_node"]);

  // The dead peer, if it ever wakes (its ops time out), ends nothing: the event is the second attempt's.
  await dying;
  expect(await eventRow(sha)).toEqual({ status: "done", attempts: 2, resumes: 1 });
}, 30_000);

test("an event that took its peer down every time ends as failed instead of taking every peer down in turn", async () => {
  const sha = await local.commit({ "a.txt": "1\n" }, "one", "main");
  const store = t.db.gitStore();
  await createGitPeer({ seed: { url: local.origin }, dir: join(local.root, "p"), log: () => undefined, store, apply: () => Promise.resolve() }).reconcile();
  await t.rawQuery("update git_events set status = 'done', finished_at = now() where after_sha <> $1", [sha]);
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await store.claim(STALE_MS, 2)).toMatchObject({ after: sha, attempt });
    await t.rawQuery("update git_events set heartbeat_at = now() - interval '1 hour' where after_sha = $1", [sha]); // its peer died
  }
  expect(await store.claim(STALE_MS, 2)).toBeUndefined();
  expect(await eventRow(sha)).toEqual({ status: "failed", attempts: 3, resumes: 2 });
});
