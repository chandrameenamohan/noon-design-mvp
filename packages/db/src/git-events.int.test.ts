import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());
beforeEach(() => t.rawQuery("delete from git_events"));

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const main = "refs/heads/main";
const STALE = 60_000;

test("the same delivery twice is one event, even if its body said something else the second time", async () => {
  const git = t.db.gitStore();
  expect(await git.record({ ref: main, before: A, after: B, deliveryId: "d-1" })).toBe(true);
  expect(await git.record({ ref: main, before: A, after: B, deliveryId: "d-1" })).toBe(false);
  expect(await git.record({ ref: main, before: B, after: C, deliveryId: "d-1" })).toBe(false); // the delivery id alone decides
  expect(await t.rawQuery("select count(*)::int as n from git_events")).toMatchObject({ rows: [{ n: 1 }] });
});

test("one commit on one branch is one event, whichever door records it first", async () => {
  const git = t.db.gitStore();
  expect(await git.record({ ref: main, before: A, after: B })).toBe(true); // the reconcile found it
  expect(await git.record({ ref: main, before: A, after: B, deliveryId: "late" })).toBe(false); // then the webhook
  expect(await git.record({ ref: "refs/heads/other", before: A, after: B })).toBe(true); // another branch is another event
  // At the same instant, too: the unique key decides, not a look-then-insert.
  const raced = await Promise.all(Array.from({ length: 10 }, (_, i) => git.record({ ref: main, before: B, after: C, deliveryId: `race-${String(i)}` })));
  expect(raced.filter(Boolean)).toHaveLength(1);
});

test("heads are the newest recorded commit per branch", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: A, after: B });
  await git.record({ ref: main, before: B, after: C });
  await git.record({ ref: "refs/heads/x", before: A, after: A });
  expect(await git.heads()).toEqual(new Map([[main, C], ["refs/heads/x", A]]));
});

test("noon-wv8.3.1: the last done commit is the branch's newest event that is done, whatever is recorded after it", async () => {
  const git = t.db.gitStore();
  expect(await git.lastDone(main)).toBeUndefined();
  await git.record({ ref: main, before: A, after: B });
  await git.record({ ref: main, before: B, after: C });
  await git.record({ ref: "refs/heads/x", before: A, after: A });
  for (let e = await git.claim(STALE, 3); e; e = await git.claim(STALE, 3)) await git.finish(e, e.after === C ? "failed" : "done");
  expect(await git.lastDone(main)).toBe(B); // C failed: not done
  expect(await git.lastDone("refs/heads/x")).toBe(A);
  expect(await git.lastDone("refs/heads/none")).toBeUndefined();
});

test("noon-wv8.3.3: an event skipped as already applied is finished, and is never the branch's last done commit", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: B, after: C });
  await git.record({ ref: main, before: A, after: B, deliveryId: "redelivered" }); // recorded later, an older commit
  for (let e = await git.claim(STALE, 3); e; e = await git.claim(STALE, 3)) await git.finish(e, e.after === B ? "skipped" : "done");
  expect(await git.lastDone(main)).toBe(C);
  expect(await t.rawQuery("select status, finished_at is not null as finished from git_events where after_sha = $1", [B])).toMatchObject({ rows: [{ status: "skipped", finished: true }] });
});

test("an event is claimed once, oldest first; handed back it waits again; finished it stays finished", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: A, after: B });
  await git.record({ ref: "refs/heads/other", before: B, after: C }); // another branch: one branch's events are taken one at a time
  const claims = await Promise.all([git.claim(STALE, 3), git.claim(STALE, 3), git.claim(STALE, 3)]);
  expect(claims.filter(Boolean).map((e) => e?.after).sort()).toEqual([B, C]);
  const first = claims.find((e) => e?.after === B);
  if (!first) throw new Error("unreachable");
  expect(first.attempt).toBe(1);
  await git.finish(first, "pending");
  const again = await git.claim(STALE, 3);
  expect(again).toEqual({ ...first, attempt: 2 });
  if (!again) throw new Error("unreachable");
  await git.finish(first, "done"); // the first attempt's: fenced, it ends nothing
  expect(await t.rawQuery("select status from git_events where id = $1", [first.id])).toMatchObject({ rows: [{ status: "running" }] });
  await git.finish(again, "done");
  await git.finish(again, "pending"); // too late: not running
  expect(await git.claim(STALE, 3)).toBeUndefined();
  expect(await t.rawQuery("select status from git_events where id = $1", [first.id])).toMatchObject({ rows: [{ status: "done" }] });
});

test("noon-wv8.3.2: an event handed back with a delay is passed by until then, and the events behind it are claimed meanwhile", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: A, after: B });
  await git.record({ ref: "refs/heads/other", before: A, after: C });
  const first = await git.claim(STALE, 3);
  expect(first?.after).toBe(B);
  if (!first) throw new Error("unreachable");
  await git.finish(first, "pending", 60_000);
  expect((await git.claim(STALE, 3))?.after).toBe(C); // not B again
  expect(await git.claim(STALE, 3)).toBeUndefined();
  await t.rawQuery("update git_events set not_before = now() - interval '1 second' where id = $1", [first.id]); // its time came
  expect(await git.claim(STALE, 3)).toMatchObject({ id: first.id, attempt: 2 });
});

test("noon-wv8.3.1.1: a branch's event is not claimed while another of its events is running, however many peers race", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: A, after: B });
  await git.record({ ref: main, before: B, after: C });
  const raced = (await Promise.all(Array.from({ length: 8 }, () => git.claim(STALE, 3)))).filter((e) => e !== undefined);
  expect(raced.map((e) => e.after)).toEqual([B]); // C waits: applied alongside B, the older pages could land last
  const [first] = raced;
  if (!first) throw new Error("unreachable");
  await git.finish(first, "done");
  expect((await git.claim(STALE, 3))?.after).toBe(C);
});

test("noon-wv8.3.1.1: an event handed back whose time comes while a newer one of its branch runs waits for that one to end", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: A, after: B });
  await git.record({ ref: main, before: B, after: C });
  const older = await git.claim(STALE, 3);
  if (!older) throw new Error("unreachable");
  await git.finish(older, "pending", 60_000);
  const newer = await git.claim(STALE, 3); // passed by meanwhile (noon-wv8.3.2)
  expect(newer?.after).toBe(C);
  if (!newer) throw new Error("unreachable");
  await t.rawQuery("update git_events set not_before = now() - interval '1 second' where id = $1", [older.id]);
  const raced = await Promise.all(Array.from({ length: 4 }, () => git.claim(STALE, 3)));
  expect(raced.filter((e) => e !== undefined)).toEqual([]);
  await git.finish(newer, "done");
  expect(await git.claim(STALE, 3)).toMatchObject({ id: older.id, attempt: 2 }); // the peer finds it already applied
});

// noon-91u: an event left running by a killed git peer is resumed once its heartbeat is stale, by ONE peer.
test("a running event is resumed only once its heartbeat is stale, by exactly one of the peers racing for it, and the dead attempt is fenced off", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: A, after: B });
  const dead = await git.claim(STALE, 3);
  if (!dead) throw new Error("unreachable");
  expect(await git.heartbeat(dead)).toBe(true);
  expect(await git.claim(STALE, 3)).toBeUndefined(); // alive: never taken
  await t.rawQuery("update git_events set heartbeat_at = now() - interval '2 minutes' where id = $1", [dead.id]); // its peer died
  const raced = await Promise.all(Array.from({ length: 8 }, () => git.claim(STALE, 3)));
  const resumed = raced.filter((e) => e !== undefined);
  expect(resumed).toEqual([{ ...dead, attempt: 2 }]);
  // The dead attempt, waking: its beat says "not yours", and its finish ends nothing.
  expect(await git.heartbeat(dead)).toBe(false);
  await git.finish(dead, "failed");
  expect(await t.rawQuery("select status, resumes from git_events where id = $1", [dead.id])).toMatchObject({ rows: [{ status: "running", resumes: 1 }] });
  const [survivor] = resumed;
  if (!survivor) throw new Error("unreachable");
  expect(await git.heartbeat(survivor)).toBe(true);
  await git.finish(survivor, "done");
  expect(await t.rawQuery("select status from git_events where id = $1", [dead.id])).toMatchObject({ rows: [{ status: "done" }] });
});

test("a push's own adds are read back from the journal by its commit, and nobody else's", async () => {
  const doc = await t.createDocument("Pushed");
  const add = (nodeId: string) => JSON.stringify({ type: "add_node", nodeId, parentId: "root", index: 0, component: "Stack", props: {} });
  const rows: [number, string, string, string | null, string][] = [
    [1, "git", "e1", B, add("mine")],
    [2, "git", "e1", B, JSON.stringify({ type: "set_prop", nodeId: "mine", key: "gap", value: 2 })],
    [3, "git", "e2", C, add("next-commit")],
    [4, "user", "u1", null, add("canvas")],
  ];
  for (const [seq, kind, actor, run, op] of rows) {
    await t.rawQuery("insert into op_journal (document_id, org_id, seq, op_id, actor_kind, actor_id, run_id, op) values ($1, $2, $3, gen_random_uuid(), $4, $5, $6, $7)", [doc.id, doc.orgId, seq, kind, actor, run, op]);
  }
  expect(await t.db.gitStore().pushedNodeIds(doc.id, B)).toEqual(new Set(["mine"]));
  expect(await t.db.gitStore().pushedNodeIds(doc.id, A)).toEqual(new Set());
  expect(await t.db.gitStore().pushedNodeIds("not-a-uuid", B)).toEqual(new Set());
});

test("reconcile requests coalesce into one flag, cleared by the one who takes it", async () => {
  const git = t.db.gitStore();
  await git.takeReconcileRequest(); // the migration leaves it set: the first start reconciles
  expect(await git.takeReconcileRequest()).toBe(false);
  await Promise.all([git.requestReconcile(), git.requestReconcile(), git.requestReconcile()]);
  expect(await git.takeReconcileRequest()).toBe(true);
  expect(await git.takeReconcileRequest()).toBe(false);
});

test("what the table would refuse is refused before the write", async () => {
  const git = t.db.gitStore();
  for (const bad of [{ ref: "refs/tags/v1", before: A, after: B }, { ref: main, before: "A".repeat(40), after: B }, { ref: main, before: A, after: B, deliveryId: "" }, { ref: main, before: A, after: B, deliveryId: "a b" }]) {
    await expect(git.record(bad), JSON.stringify(bad)).rejects.toThrow();
  }
  await expect(t.rawQuery("insert into git_events (ref, before_sha, after_sha) values ('refs/heads/x', 'nope', $1)", [A])).rejects.toMatchObject({ code: "23514" });
});

test("a generated page's document names its org, whatever org that is; an unknown or malformed id names none", async () => {
  const org = await t.createOrg("Pushed to");
  const ws = await t.db.forOrg(org.id).createWorkspace({ name: "ws" });
  const doc = await t.db.forOrg(org.id).createDocument({ workspaceId: ws.id, title: "page" });
  expect(await t.db.gitStore().documentOrg(doc?.id ?? "")).toBe(org.id);
  expect(await t.db.gitStore().documentOrg("0f9c7a0e-1b2c-4d3e-8f00-00000000dead")).toBeUndefined();
  expect(await t.db.gitStore().documentOrg("not-a-uuid")).toBeUndefined();
});
