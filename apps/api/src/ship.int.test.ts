import { expect, test } from "vitest";
import { Document, DocumentShip, Org, Ship, Workspace } from "@noon/contracts";
import type { JobRef } from "@noon/queue";
import { useTestServer } from "./testing.ts";

// E5.5 (F17): pressing Ship is a job. Presses coalesce into the ship still waiting, so two at once make ONE; a
// press while one runs queues the next. The worker's half (git, Gitea) is apps/worker/src/ship.int.test.ts.
const enqueued: JobRef[] = [];
const ctx = useTestServer({ enqueue: (ref) => { enqueued.push(ref); return Promise.resolve(); } });
const call = (user: string, method: "GET" | "POST", path: string, body?: unknown) =>
  ctx.fetch(path, { method, headers: { "x-dev-user": user, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ship = (user: string, doc: Document) => call(user, "POST", `/documents/${doc.id}/ship`);
const newest = async (user: string, doc: Document) => DocumentShip.parse(await (await call(user, "GET", `/documents/${doc.id}/ship`)).json()).ship;

async function shippable(owner: string): Promise<Document> {
  const org = Org.parse(await (await call(owner, "POST", "/orgs", { name: "Ships" })).json());
  const ws = Workspace.parse(await (await call(owner, "POST", `/orgs/${org.id}/workspaces`, { name: "w" })).json());
  return Document.parse(await (await call(owner, "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Checkout" })).json());
}
const shipJobs = async (doc: Document): Promise<{ id: string; status: string }[]> =>
  ((await ctx.db.rawQuery("select id, status from jobs where document_id = $1 and queue = 'ship' order by created_at", [doc.id])) as { rows: { id: string; status: string }[] }).rows;

test("twenty presses at once make ONE ship, enqueued once; every press is answered with it", async () => {
  const doc = await shippable("ann@example.com");
  expect(await newest("ann@example.com", doc)).toBeNull();
  const answers = await Promise.all(Array.from({ length: 20 }, () => ship("ann@example.com", doc)));
  expect(answers.map((a) => a.status).sort()).toEqual([201, ...Array<number>(19).fill(200)]);
  const ships = await Promise.all(answers.map(async (a) => Ship.parse(await a.json())));
  const [job] = await shipJobs(doc);
  expect(await shipJobs(doc)).toEqual([{ id: job?.id, status: "queued" }]);
  expect(new Set(ships.map((s) => s.id))).toEqual(new Set([job?.id]));
  expect(enqueued.filter((ref) => ref.jobId === job?.id)).toEqual([{ queue: "ship", jobId: job?.id, orgId: doc.orgId }]);
});

test("a press while a ship RUNS queues the next one; the canvas reads the newest, with its commit and pull request", async () => {
  const doc = await shippable("ann@example.com");
  const first = Ship.parse(await (await ship("ann@example.com", doc)).json());
  const key = { queue: "ship" as const, jobId: first.id, orgId: doc.orgId };
  await ctx.db.db.jobStore().claim(key);
  const pr = { number: 4, url: "http://localhost:3002/noon/sample-app/pulls/4" };
  await ctx.db.db.jobStore().report(key, { commit: "c".repeat(40), pr });
  expect(await newest("ann@example.com", doc)).toMatchObject({ id: first.id, status: "running", commit: "c".repeat(40), pr });
  expect(await ctx.db.db.gitStore().shippedCommit("c".repeat(40))).toBe(true); // what the git peer skips
  expect(await ctx.db.db.gitStore().shippedCommit("d".repeat(40))).toBe(false);

  const second = await ship("ann@example.com", doc);
  expect(second.status).toBe(201);
  expect(Ship.parse(await second.json())).toMatchObject({ status: "queued", commit: null, pr: null });
  expect((await shipJobs(doc)).map((j) => j.status)).toEqual(["running", "queued"]);
});

test("a ship's output is checked before it is written: a pull request link that is not http(s) never reaches the canvas", async () => {
  const doc = await shippable("ann@example.com");
  const started = Ship.parse(await (await ship("ann@example.com", doc)).json());
  const key = { queue: "ship" as const, jobId: started.id, orgId: doc.orgId };
  await ctx.db.db.jobStore().claim(key);
  await expect(ctx.db.db.jobStore().report(key, { commit: null, pr: { number: 1, url: "javascript:alert(1)" } })).rejects.toThrow();
  await expect(ctx.db.db.jobStore().report(key, { url: "http://127.0.0.1:1/" })).rejects.toThrow(); // a preview's output on a ship
});

test("only members may ship or read a ship; to anyone else the document does not exist", async () => {
  const doc = await shippable("ann@example.com");
  expect((await ship("bob@example.com", doc)).status).toBe(404);
  expect((await call("bob@example.com", "GET", `/documents/${doc.id}/ship`)).status).toBe(404);
  expect((await call("ann@example.com", "GET", "/documents/not-an-id/ship")).status).toBe(404);
  expect(await shipJobs(doc)).toEqual([]);
});
