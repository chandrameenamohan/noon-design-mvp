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

test("an event is claimed once, oldest first; handed back it waits again; finished it stays finished", async () => {
  const git = t.db.gitStore();
  await git.record({ ref: main, before: A, after: B });
  await git.record({ ref: main, before: B, after: C });
  const claims = await Promise.all([git.claim(), git.claim(), git.claim()]);
  expect(claims.filter(Boolean).map((e) => e?.after).sort()).toEqual([B, C]);
  const first = claims.find((e) => e?.after === B);
  if (!first) throw new Error("unreachable");
  await git.finish(first.id, "pending");
  expect(await git.claim()).toEqual(first);
  await git.finish(first.id, "done");
  await git.finish(first.id, "pending"); // too late: not running
  expect(await git.claim()).toBeUndefined();
  expect(await t.rawQuery("select status from git_events where id = $1", [first.id])).toMatchObject({ rows: [{ status: "done" }] });
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
