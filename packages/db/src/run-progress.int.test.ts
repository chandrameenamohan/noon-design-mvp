import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "./testing.ts";

// E9.4 (F30): an AI run's steps live on its row (jobs.output), written by the attempt that holds it, read with the run.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

async function aRun(instruction = "add a card") {
  const doc = await t.createDocument("Progress");
  const run = await t.db.forOrg(doc.orgId).createRun({ documentId: doc.id, instruction, createdBy: undefined });
  if (run === undefined || typeof run === "string") throw new Error(`no run: ${String(run)}`);
  return { run, doc, key: { queue: "ai" as const, jobId: run.id, orgId: doc.orgId } };
}
const step = (detail: string, ok = true) => ({ tool: "add_node", ok, detail });

test("a running attempt's steps are read with the run, by id and as the document's newest run, and stay once it ends", async () => {
  const jobs = t.db.jobStore();
  const { run, doc, key } = await aRun();
  const org = t.db.forOrg(doc.orgId);
  expect(await org.getLatestRun(doc.id)).toMatchObject({ id: run.id, status: "queued", steps: [] });
  await jobs.claim(key);
  await jobs.report({ ...key, attempt: 1 }, { steps: [step("Card"), step("Nope", false)] });
  expect((await org.getRun(doc.id, run.id))?.steps).toEqual([step("Card"), step("Nope", false)]);
  await jobs.finish({ ...key, attempt: 1 }, "succeeded");
  expect(await org.getLatestRun(doc.id)).toMatchObject({ id: run.id, status: "succeeded", steps: [step("Card"), step("Nope", false)] }); // a reload after the end still shows them
  await jobs.report({ ...key, attempt: 1 }, { steps: [] }); // a finished run is left as it is
  expect((await org.getRun(doc.id, run.id))?.steps).toHaveLength(2);
});

test("a dead attempt's steps never show: the requeue forgets them and its late report lands nowhere (F28 fence)", async () => {
  const jobs = t.db.jobStore();
  const { run, doc, key } = await aRun();
  await jobs.claim(key);
  await jobs.report({ ...key, attempt: 1 }, { steps: [step("FromTheDeadOne")] });
  await t.rawQuery("update jobs set heartbeat_at = now() - interval '1 minute' where id = $1", [run.id]);
  await jobs.requeueStale(10_000, 3);
  expect((await t.db.forOrg(doc.orgId).getRun(doc.id, run.id))?.steps).toEqual([]);
  await jobs.claim(key); // attempt 2
  await jobs.report({ ...key, attempt: 1 }, { steps: [step("FromTheDeadOne")] }); // the slow first worker wakes up
  expect((await t.db.forOrg(doc.orgId).getRun(doc.id, run.id))?.steps).toEqual([]);
  await jobs.report({ ...key, attempt: 2 }, { steps: [step("Card")] });
  expect((await t.db.forOrg(doc.orgId).getRun(doc.id, run.id))?.steps).toEqual([step("Card")]);
});

test("steps are checked against the contract BEFORE the write, and a row that does not parse reads as no steps", async () => {
  const jobs = t.db.jobStore();
  const { run, doc, key } = await aRun();
  await jobs.claim(key);
  await expect(jobs.report({ ...key, attempt: 1 }, { steps: [{ tool: "add_node", ok: true, detail: "x".repeat(81) }] })).rejects.toThrow();
  await t.rawQuery("update jobs set output = '{\"steps\": [{\"tool\": \"<b>\", \"ok\": 1}]}' where id = $1", [run.id]);
  expect((await t.db.forOrg(doc.orgId).getRun(doc.id, run.id))?.steps).toEqual([]);
});

test("the newest run is the document's own, in this org only; null when the AI was never asked", async () => {
  const doc = await t.createDocument("Never asked");
  expect(await t.db.forOrg(doc.orgId).getLatestRun(doc.id)).toBeNull();
  const other = await t.createOrg("elsewhere");
  expect(await t.db.forOrg(other.id).getLatestRun(doc.id)).toBeUndefined();
  const { doc: busy } = await aRun("first");
  await t.db.forOrg(busy.orgId).cancelRun(busy.id, ((await t.db.forOrg(busy.orgId).getLatestRun(busy.id)) ?? { id: "" }).id);
  const second = await t.db.forOrg(busy.orgId).createRun({ documentId: busy.id, instruction: "second", createdBy: undefined });
  expect(await t.db.forOrg(busy.orgId).getLatestRun(busy.id)).toMatchObject({ id: typeof second === "object" ? second.id : "", instruction: "second" });
});
