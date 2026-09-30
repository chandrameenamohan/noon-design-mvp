import { expect, test } from "vitest";
import { Document, ErrorBody, Org, Preview, Workspace } from "@noon/contracts";
import type { JobRef } from "@noon/queue";
import { buildApp } from "./app.ts";
import { devHeaderIdentity } from "./identity.ts";
import { TEST_SESSIONS, useTestServer } from "./testing.ts";

// E4.3: the canvas asks for its document's preview (POST) and, once a second, where it answers (GET).
const enqueued: JobRef[] = [];
const ctx = useTestServer({ enqueue: (ref) => { enqueued.push(ref); return Promise.resolve(); } });
const as = (user: string, method: string, path: string) => ctx.fetch(path, { method, headers: { "x-dev-user": user } });
const open = async (user: string, doc: Document) => as(user, "POST", `/documents/${doc.id}/preview`);
const read = async (user: string, doc: Document) => Preview.parse(await (await as(user, "GET", `/documents/${doc.id}/preview`)).json());

async function anOrg(owner: string): Promise<{ org: Org; ws: Workspace }> {
  const org = Org.parse(await (await ctx.fetch("/orgs", { method: "POST", headers: { "x-dev-user": owner, "content-type": "application/json" }, body: JSON.stringify({ name: "Previews" }) })).json());
  const ws = Workspace.parse(await (await ctx.fetch(`/orgs/${org.id}/workspaces`, { method: "POST", headers: { "x-dev-user": owner, "content-type": "application/json" }, body: JSON.stringify({ name: "ws" }) })).json());
  return { org, ws };
}
const aDocumentIn = async (owner: string, { org, ws }: { org: Org; ws: Workspace }): Promise<Document> =>
  Document.parse(await (await ctx.fetch(`/orgs/${org.id}/workspaces/${ws.id}/documents`, { method: "POST", headers: { "x-dev-user": owner, "content-type": "application/json" }, body: JSON.stringify({ title: "Checkout" }) })).json());
const jobsOf = async (doc: Document): Promise<{ id: string; status: string }[]> =>
  ((await ctx.db.rawQuery("select id, status from jobs where document_id = $1 and queue = 'sandbox' order by created_at", [doc.id])) as { rows: { id: string; status: string }[] }).rows;

test("opening a preview queues ONE sandbox job and enqueues it; opening again finds the same job", async () => {
  const doc = await aDocumentIn("ann@example.com", await anOrg("ann@example.com"));
  expect(await read("ann@example.com", doc)).toEqual({ status: "none", url: null });

  const first = await open("ann@example.com", doc);
  expect(first.status).toBe(201);
  expect(Preview.parse(await first.json())).toEqual({ status: "queued", url: null });
  const [job] = await jobsOf(doc);
  expect(enqueued).toContainEqual({ queue: "sandbox", jobId: job?.id, orgId: doc.orgId });

  const again = await open("ann@example.com", doc);
  expect(again.status).toBe(200);
  expect(await jobsOf(doc)).toHaveLength(1);
  expect(enqueued.filter((ref) => ref.jobId === job?.id)).toHaveLength(1);
});

test("the URL is read from the RUNNING job, as it is now; a finished job's old URL is never handed out", async () => {
  const doc = await aDocumentIn("ann@example.com", await anOrg("ann@example.com"));
  await open("ann@example.com", doc);
  const [job] = await jobsOf(doc);
  const key = { queue: "sandbox" as const, jobId: job?.id ?? "", orgId: doc.orgId };
  await ctx.db.db.jobStore().claim(key);
  expect(await read("ann@example.com", doc)).toEqual({ status: "running", url: null }); // starting
  await ctx.db.db.jobStore().report(key, { url: `http://127.0.0.1:20001/noon-preview/?doc=${doc.id}` });
  expect(await read("ann@example.com", doc)).toEqual({ status: "running", url: `http://127.0.0.1:20001/noon-preview/?doc=${doc.id}` });
  await ctx.db.db.jobStore().report(key, null); // the container died: rebuilding
  expect(await read("ann@example.com", doc)).toEqual({ status: "running", url: null });
  await ctx.db.db.jobStore().report(key, { url: `http://127.0.0.1:20002/noon-preview/?doc=${doc.id}` }); // back, on another port
  expect((await read("ann@example.com", doc)).url).toBe(`http://127.0.0.1:20002/noon-preview/?doc=${doc.id}`);

  await ctx.db.db.jobStore().finish(key, "succeeded");
  expect(await read("ann@example.com", doc)).toEqual({ status: "succeeded", url: null });
  // Opening again after the end starts a new job.
  expect((await open("ann@example.com", doc)).status).toBe(201);
  expect((await jobsOf(doc)).map((j) => j.status)).toEqual(["succeeded", "queued"]);
});

test("a stored URL that is not a loopback http(s) address never reaches the canvas", async () => {
  const doc = await aDocumentIn("ann@example.com", await anOrg("ann@example.com"));
  await open("ann@example.com", doc);
  const [job] = await jobsOf(doc);
  await ctx.db.rawQuery("update jobs set status = 'running', started_at = now(), output = $2 where id = $1", [job?.id, JSON.stringify({ url: "https://evil.example/" })]);
  expect(await read("ann@example.com", doc)).toEqual({ status: "running", url: null });
});

test("someone else's document, an unknown one and a malformed id are the same 404, and start nothing", async () => {
  const doc = await aDocumentIn("ann@example.com", await anOrg("ann@example.com"));
  for (const path of [`/documents/${doc.id}/preview`, "/documents/7b6f1c2e-0000-4000-8000-000000000000/preview", "/documents/not-a-uuid/preview"]) {
    for (const method of ["POST", "GET"]) {
      const res = await as("mallory@example.com", method, path);
      expect(res.status).toBe(404);
      expect(ErrorBody.parse(await res.json())).toEqual({ error: "not_found" });
    }
  }
  expect(await jobsOf(doc)).toHaveLength(0);
});

test("one org holds at most 4 previews at once: the fifth document is refused by name until one ends", async () => {
  const org = await anOrg("bea@example.com");
  const docs = await Promise.all([1, 2, 3, 4, 5].map(() => aDocumentIn("bea@example.com", org)));
  for (const doc of docs.slice(0, 4)) expect((await open("bea@example.com", doc)).status).toBe(201);
  const refused = await open("bea@example.com", docs[4] as Document);
  expect(refused.status).toBe(409);
  expect(ErrorBody.parse(await refused.json())).toEqual({ error: "preview_limit" });
  // Another org is not held up by this one.
  expect((await open("cat@example.com", await aDocumentIn("cat@example.com", await anOrg("cat@example.com")))).status).toBe(201);
  // One of the four is re-opened fine (it is the same job), and once one ends, the fifth gets in.
  expect((await open("bea@example.com", docs[0] as Document)).status).toBe(200);
  const [job] = await jobsOf(docs[0] as Document);
  await ctx.db.rawQuery("update jobs set status = 'cancelled', finished_at = now() where id = $1", [job?.id]);
  expect((await open("bea@example.com", docs[4] as Document)).status).toBe(201);
});

test("a stored URL that no parser can read is 'no URL', never a 500 (a refine must not throw)", async () => {
  const doc = await aDocumentIn("ann@example.com", await anOrg("ann@example.com"));
  await open("ann@example.com", doc);
  const [job] = await jobsOf(doc);
  // Only reachable by writing the row by hand (report() refuses both), which is exactly what a migration
  // or a psql session can do. Zod runs a refine even after the format check failed.
  for (const url of ["http://127.0.0.1:99999/", "//127.0.0.1:1/"]) {
    await ctx.db.rawQuery("update jobs set status = 'running', started_at = now(), output = $2 where id = $1", [job?.id, JSON.stringify({ url })]);
    const res = await as("ann@example.com", "GET", `/documents/${doc.id}/preview`);
    expect(res.status).toBe(200);
    expect(Preview.parse(await res.json())).toEqual({ status: "running", url: null });
  }
});

test("after a failed preview the canvas cannot pile up jobs: one retry per cooldown, whoever asks", async () => {
  const doc = await aDocumentIn("ann@example.com", await anOrg("ann@example.com"));
  await open("ann@example.com", doc);
  const [first] = await jobsOf(doc);
  await ctx.db.rawQuery("update jobs set status = 'failed', finished_at = now(), error = 'sandbox_unavailable' where id = $1", [first?.id]);
  // The canvas asks again every second while there is no preview.
  for (let i = 0; i < 5; i++) expect((await open("ann@example.com", doc)).status).toBe(200);
  expect(await jobsOf(doc)).toHaveLength(1);
  expect(await read("ann@example.com", doc)).toEqual({ status: "failed", url: null });
  // Once the pause is over, it tries again.
  await ctx.db.rawQuery("update jobs set finished_at = now() - interval '11 seconds' where id = $1", [first?.id]);
  expect((await open("ann@example.com", doc)).status).toBe(201);
  expect(await jobsOf(doc)).toHaveLength(2);
});

test("behind one public URL (PREVIEW_PUBLIC_URL) both answers give the same path on the public origin; the row keeps the loopback", async () => {
  const doc = await aDocumentIn("ann@example.com", await anOrg("ann@example.com"));
  await open("ann@example.com", doc);
  const [job] = await jobsOf(doc);
  const key = { queue: "sandbox" as const, jobId: job?.id ?? "", orgId: doc.orgId };
  await ctx.db.db.jobStore().claim(key);
  const stored = `http://127.0.0.1:20001/preview/${doc.id}/20001/noon-preview/?doc=${doc.id}&started=5`;
  await ctx.db.db.jobStore().report(key, { url: stored });

  const hosted = buildApp({ db: ctx.db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.resolve(), previewOrigin: "https://noon.example.com" });
  const public_ = `https://noon.example.com/preview/${doc.id}/20001/noon-preview/?doc=${doc.id}&started=5`;
  for (const method of ["GET", "POST"]) {
    const res = await hosted.request(`/documents/${doc.id}/preview`, { method, headers: { "x-dev-user": "ann@example.com" } });
    expect(Preview.parse(await res.json()), method).toEqual({ status: "running", url: public_ });
  }
  expect((await read("ann@example.com", doc)).url).toBe(stored); // the same row, read without a public origin
});
