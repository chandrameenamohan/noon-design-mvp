import { describe, expect, test } from "vitest";
import { Document, ErrorBody, Org, Run, Ship, Workspace } from "@noon/contracts";
import type { JobRef } from "@noon/queue";
import { useTestServer } from "./testing.ts";

// integration:idempotency-key-race (E9.1, F27). "Start AI run" and "ship" retried with one Idempotency-Key make ONE
// job, however many requests arrive at the same moment, and every answer is read from that job's row. The queue
// answers nothing: its add() here records the ref and, when told to, fails, and the answers do not change.
const enqueued: JobRef[] = [];
let queueDown = false;
const ctx = useTestServer({ enqueue: (ref) => { enqueued.push(ref); return queueDown ? Promise.reject(new Error("redis away")) : Promise.resolve(); } });

const post = (user: string, path: string, body?: unknown, key?: string) =>
  ctx.fetch(path, { method: "POST", headers: { "x-dev-user": user, "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const run = (user: string, doc: Document, key: string | undefined, instruction = "add a hero") => post(user, `/documents/${doc.id}/runs`, { instruction }, key);
const ship = (user: string, doc: Document, key: string | undefined) => post(user, `/documents/${doc.id}/ship`, undefined, key);

async function document(owner: string): Promise<Document> {
  const org = Org.parse(await (await post(owner, "/orgs", { name: "Keys" })).json());
  const ws = Workspace.parse(await (await post(owner, `/orgs/${org.id}/workspaces`, { name: "w" })).json());
  return Document.parse(await (await post(owner, `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Checkout" })).json());
}
const jobs = async (doc: Document, queue: "ai" | "ship"): Promise<{ id: string; status: string }[]> =>
  ((await ctx.db.rawQuery("select id, status from jobs where document_id = $1 and queue = $2 order by created_at", [doc.id, queue])) as { rows: { id: string; status: string }[] }).rows;
const finish = async (doc: Document, jobId: string, queue: "ai" | "ship" = "ai"): Promise<void> => {
  const key = { queue, jobId, orgId: doc.orgId };
  await ctx.db.db.jobStore().claim(key);
  await ctx.db.db.jobStore().finish(key, "succeeded");
};
const error = async (res: Response): Promise<string> => ErrorBody.parse(await res.json()).error;

describe("integration:idempotency-key-race", () => {
  test("twenty simultaneous starts with one key make ONE run, and all twenty are answered with it, from its row", async () => {
    const doc = await document("ann@example.com");
    const key = crypto.randomUUID();
    queueDown = true; // nothing the queue says (or fails to say) reaches the answer
    const answers = await Promise.all(Array.from({ length: 20 }, () => run("ann@example.com", doc, key)));
    queueDown = false;
    expect(answers.map((a) => a.status)).toEqual(Array<number>(20).fill(201));
    const runs = await Promise.all(answers.map(async (a) => Run.parse(await a.json())));
    const rows = await jobs(doc, "ai");
    expect(rows).toEqual([{ id: rows[0]?.id, status: "queued" }]);
    expect(new Set(runs.map((r) => r.id))).toEqual(new Set([rows[0]?.id]));

    // Later, the same key answers the run as its row NOW is, not as it was when it was made.
    await ctx.db.db.jobStore().claim({ queue: "ai", jobId: runs[0]?.id ?? "", orgId: doc.orgId });
    const again = await run("ann@example.com", doc, key);
    expect(again.status).toBe(201);
    expect(Run.parse(await again.json())).toMatchObject({ id: runs[0]?.id, status: "running" });
    expect(await jobs(doc, "ai")).toHaveLength(1);
  });

  test("twenty simultaneous ships with one key make ONE ship; the key keeps naming it after newer ships are queued", async () => {
    const doc = await document("ann@example.com");
    const key = crypto.randomUUID();
    const answers = await Promise.all(Array.from({ length: 20 }, () => ship("ann@example.com", doc, key)));
    expect(answers.map((a) => a.status).sort()).toEqual([...Array<number>(19).fill(200), 201]);
    const ships = await Promise.all(answers.map(async (a) => Ship.parse(await a.json())));
    const [first] = await jobs(doc, "ship");
    expect(await jobs(doc, "ship")).toHaveLength(1);
    expect(new Set(ships.map((s) => s.id))).toEqual(new Set([first?.id]));
    expect(enqueued.filter((ref) => ref.jobId === first?.id)).toHaveLength(1); // only the press that made it enqueued it

    // It runs, and another press (another key) queues the next ship: the first key still answers the first ship.
    await ctx.db.db.jobStore().claim({ queue: "ship", jobId: first?.id ?? "", orgId: doc.orgId });
    expect((await ship("ann@example.com", doc, crypto.randomUUID())).status).toBe(201);
    const replay = await ship("ann@example.com", doc, key);
    expect(replay.status).toBe(200);
    expect(Ship.parse(await replay.json())).toMatchObject({ id: first?.id, status: "running" });
    expect(await jobs(doc, "ship")).toHaveLength(2);
  });

  test("a press that joined the waiting ship keeps its key on that ship", async () => {
    const doc = await document("ann@example.com");
    const made = Ship.parse(await (await ship("ann@example.com", doc, crypto.randomUUID())).json());
    const key = crypto.randomUUID();
    expect((await ship("ann@example.com", doc, key)).status).toBe(200); // joined
    await finish(doc, made.id, "ship");
    expect((await ship("ann@example.com", doc, crypto.randomUUID())).status).toBe(201); // a newer ship waits now
    expect(Ship.parse(await (await ship("ann@example.com", doc, key)).json()).id).toBe(made.id);
  });

  test("the same key with a different request is refused with 422, and makes nothing", async () => {
    const doc = await document("ann@example.com");
    // Same org: a key is scoped to (org, user), so a document in another org would be a fresh key (next test).
    const other = Document.parse(await (await post("ann@example.com", `/orgs/${doc.orgId}/workspaces/${doc.workspaceId}/documents`, { title: "Other" })).json());
    const key = crypto.randomUUID();
    const made = Run.parse(await (await run("ann@example.com", doc, key, "add a hero")).json());
    await finish(doc, made.id);
    for (const res of [
      await run("ann@example.com", doc, key, "add a footer"), // another instruction
      await ship("ann@example.com", doc, key), // another kind of job
      await run("ann@example.com", other, key, "add a hero"), // another document
    ]) {
      expect(res.status).toBe(422);
      expect(await error(res)).toBe("idempotency_key_reused");
    }
    expect(await jobs(doc, "ai")).toHaveLength(1);
    expect(await jobs(doc, "ship")).toEqual([]);
    expect(await jobs(other, "ai")).toEqual([]);
  });

  test("a key belongs to its user in its org: another tenant's same key is theirs, and never reads this job", async () => {
    const mine = await document("ann@example.com");
    const theirs = await document("bob@example.com");
    const sameUserOtherOrg = await document("ann@example.com");
    const key = "shared-key-1";
    const a = Run.parse(await (await run("ann@example.com", mine, key)).json());
    const b = await run("bob@example.com", theirs, key);
    expect(b.status).toBe(201);
    expect(Run.parse(await b.json()).id).not.toBe(a.id);
    const c = await run("ann@example.com", sameUserOtherOrg, key);
    expect(c.status).toBe(201);
    expect(Run.parse(await c.json()).id).not.toBe(a.id);
    // bob cannot reach ann's document with ann's key either: to him it does not exist.
    expect((await run("bob@example.com", mine, key)).status).toBe(404);
  });

  test("a start refused as busy does not use up its key: once the run ends, the same key starts the next one", async () => {
    const doc = await document("ann@example.com");
    const first = Run.parse(await (await run("ann@example.com", doc, crypto.randomUUID())).json());
    const key = crypto.randomUUID();
    const busy = await run("ann@example.com", doc, key, "next");
    expect(busy.status).toBe(409);
    expect(await error(busy)).toBe("run_in_progress");
    await finish(doc, first.id);
    const next = await run("ann@example.com", doc, key, "next");
    expect(next.status).toBe(201);
    expect(Run.parse(await next.json()).id).not.toBe(first.id);
  });

  test("a key lives 24 hours: after that it is free, even for a different request", async () => {
    const doc = await document("ann@example.com");
    const key = crypto.randomUUID();
    const first = Run.parse(await (await run("ann@example.com", doc, key)).json());
    await finish(doc, first.id);
    await ctx.db.rawQuery("update idempotency_keys set created_at = now() - interval '24 hours 1 minute' where key = $1", [key]);
    const later = await run("ann@example.com", doc, key, "something else");
    expect(later.status).toBe(201);
    expect(Run.parse(await later.json()).id).not.toBe(first.id);
  });

  test("a malformed key is refused, never ignored; no key at all is the old behaviour", async () => {
    const doc = await document("ann@example.com");
    for (const key of ["", "a key with spaces", "k".repeat(256)]) {
      const res = await run("ann@example.com", doc, key);
      expect(res.status).toBe(400);
      expect(await error(res)).toBe("invalid_body");
    }
    expect(await jobs(doc, "ai")).toEqual([]);
    const answers = await Promise.all(Array.from({ length: 5 }, () => run("ann@example.com", doc, undefined)));
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });
});
