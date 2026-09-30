import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Document, ErrorBody, Org, Run, UsageReport, Workspace } from "@noon/contracts";
import { Queue } from "bullmq";
import { connection, createProducer, type Producer } from "@noon/queue";
import { TEST_REDIS_URL } from "../../../packages/queue/src/testing.ts";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { devHeaderIdentity } from "../../api/src/identity.ts";
import { startServer, type RunningServer } from "../../api/src/server.ts";
import { TEST_SESSIONS } from "../../api/src/testing.ts";
import { JobFailure, startWorker, type Handlers, type RunningWorker } from "./worker.ts";

type AiHandler = NonNullable<Handlers["ai"]>;

// integration:run-create-to-terminal. The real api, the real worker, real Postgres and real Redis;
// each test file gets its own Postgres schema and its own BullMQ key prefix.
const prefix = `test-${randomBytes(6).toString("hex")}`;
let db: TestDb, producer: Producer, api: RunningServer, worker: RunningWorker | undefined;
let aiCalls: unknown[] = [];
const record: AiHandler = (job) => {
  aiCalls.push(job.input["instruction"]);
  return Promise.resolve(undefined);
};
let ai: AiHandler = record;

beforeAll(async () => {
  db = await createTestDb();
  producer = createProducer({ redisUrl: TEST_REDIS_URL, prefix });
  api = await startServer({ port: 0, db: db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: producer.enqueue });
});
afterAll(async () => {
  await worker?.close();
  await api.close();
  await producer.close();
  await db.drop();
});
const work = async (sweepMs = 60_000) => (worker = await startWorker({ db: db.db, redisUrl: TEST_REDIS_URL, prefix, handlers: { ai: (job, cancelled) => ai(job, cancelled) }, sweepMs, cancelPollMs: 100 }));

const as = (user: string, method: string, path: string, body?: unknown) =>
  fetch(`${api.url}${path}`, { method, headers: { "x-dev-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function aDocument(owner: string): Promise<Document> {
  const org = Org.parse(await (await as(owner, "POST", "/orgs", { name: "Runs" })).json());
  const ws = Workspace.parse(await (await as(owner, "POST", `/orgs/${org.id}/workspaces`, { name: "ws" })).json());
  return Document.parse(await (await as(owner, "POST", `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Checkout" })).json());
}
const startRun = async (user: string, doc: Document, instruction: string) => Run.parse(await (await as(user, "POST", `/documents/${doc.id}/runs`, { instruction })).json());
const readRun = async (user: string, run: Run) => Run.parse(await (await as(user, "GET", `/documents/${run.documentId}/runs/${run.id}`)).json());
async function terminal(user: string, run: Run): Promise<Run> {
  for (let i = 0; i < 200; i++) {
    const now = await readRun(user, run);
    if (now.status !== "queued" && now.status !== "running") return now;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the run never reached a terminal status");
}
const count = async (sql: string, params: unknown[]) => ((await db.rawQuery(sql, params)) as { rows: { n: number }[] }).rows[0]?.n;

test("a run created through the api reaches `succeeded` through the worker, having applied zero ops", async () => {
  const doc = await aDocument("ann@example.com");
  const created = await as("ann@example.com", "POST", `/documents/${doc.id}/runs`, { instruction: "  add a payment card\nwith a Pay button " });
  expect(created.status).toBe(201);
  const run = Run.parse(await created.json());
  expect(run).toMatchObject({ documentId: doc.id, orgId: doc.orgId, status: "queued", instruction: "add a payment card\nwith a Pay button", error: null, startedAt: null, finishedAt: null });
  expect(await readRun("ann@example.com", run)).toEqual(run); // no worker yet: it waits

  await work();
  const done = await terminal("ann@example.com", run);
  expect(done).toMatchObject({ status: "succeeded", error: null });
  expect(done.startedAt).not.toBeNull();
  expect(done.finishedAt).not.toBeNull();
  expect(aiCalls).toEqual(["add a payment card\nwith a Pay button"]);

  // That run was found by the worker's startup sweep. This one can only arrive through the api's own
  // enqueue: the next sweep is a minute away.
  aiCalls = [];
  const live = await terminal("ann@example.com", await startRun("ann@example.com", doc, "delivered live"));
  expect(live.status).toBe("succeeded");
  expect(aiCalls).toEqual(["delivered live"]);
  // Zero ops: the document is exactly as it was created.
  expect(await count("select count(*)::int as n from documents where id = $1 and seq = 0 and content is null", [doc.id])).toBe(1);
});

test("a handler that fails ends the run as `failed` with its named reason, never the raw error", async () => {
  const doc = await aDocument("ann@example.com");
  ai = () => Promise.reject(new JobFailure("token_missing"));
  expect(await terminal("ann@example.com", await startRun("ann@example.com", doc, "x"))).toMatchObject({ status: "failed", error: "token_missing" });

  ai = () => Promise.reject(new Error("password=hunter2 at /repo/apps/worker/src/secret.ts"));
  const crashed = await terminal("ann@example.com", await startRun("ann@example.com", doc, "x"));
  expect(crashed).toMatchObject({ status: "failed", error: "internal" });
  expect(crashed.finishedAt).not.toBeNull();
});

test("someone else's document, an unknown run and a run named under the wrong document are the same 404", async () => {
  ai = record;
  const doc = await aDocument("ann@example.com");
  const other = await aDocument("ann@example.com");
  const run = await startRun("ann@example.com", doc, "x");
  const answers = await Promise.all([
    as("eve@example.com", "POST", `/documents/${doc.id}/runs`, { instruction: "x" }),
    as("eve@example.com", "GET", `/documents/${doc.id}/runs/${run.id}`),
    as("ann@example.com", "GET", `/documents/${other.id}/runs/${run.id}`),
    as("ann@example.com", "GET", `/documents/${doc.id}/runs/${doc.id}`),
    as("ann@example.com", "GET", `/documents/${doc.id}/runs/not-a-uuid`),
  ]);
  for (const res of answers) {
    expect(res.status).toBe(404);
    expect(ErrorBody.parse(await res.json())).toEqual({ error: "not_found" });
  }
  expect(await count("select count(*)::int as n from jobs where document_id = $1", [doc.id])).toBe(1);
});

test.each([[{}], [{ instruction: "" }], [{ instruction: "   " }], [{ instruction: `a${String.fromCharCode(0)}b` }], [{ instruction: "x".repeat(4001) }], [{ instruction: "x", model: "opus" }]])(
  "a bad body %j is refused before anything is stored",
  async (body) => {
    const doc = await aDocument("bob@example.com");
    const res = await as("bob@example.com", "POST", `/documents/${doc.id}/runs`, body);
    expect(res.status).toBe(400);
    expect(await count("select count(*)::int as n from jobs where document_id = $1", [doc.id])).toBe(0);
  },
);

test("with Redis away the api still answers 201, and the worker's sweep finds the run that was never enqueued", async () => {
  await worker?.close();
  worker = undefined;
  const doc = await aDocument("ann@example.com");
  const deaf = await startServer({ port: 0, db: db.db, identify: devHeaderIdentity, sessions: TEST_SESSIONS, enqueue: () => Promise.reject(new Error("redis did not answer")) });
  try {
    const res = await fetch(`${deaf.url}/documents/${doc.id}/runs`, { method: "POST", headers: { "x-dev-user": "ann@example.com", "content-type": "application/json" }, body: JSON.stringify({ instruction: "never enqueued" }) });
    expect(res.status).toBe(201);
    const lost = Run.parse(await res.json());
    await work(50);
    expect(await terminal("ann@example.com", lost)).toMatchObject({ status: "succeeded" });
  } finally {
    await deaf.close();
  }
});

test("a job delivered again after it finished does not run again, and its result stands", async () => {
  const doc = await aDocument("ann@example.com");
  aiCalls = [];
  ai = record;
  const run = await startRun("ann@example.com", doc, "once");
  const done = await terminal("ann@example.com", run);
  // Postgres says "finished" a moment BEFORE BullMQ removes its message, and until then an add with
  // the same jobId is dropped. Keep delivering: the later ones are brand-new messages for a finished job.
  ai = () => Promise.reject(new JobFailure("ran_twice"));
  for (let i = 0; i < 10; i++) {
    await producer.enqueue({ queue: "ai", jobId: run.id, orgId: run.orgId });
    await new Promise((r) => setTimeout(r, 40));
  }
  expect(aiCalls).toEqual(["once"]);
  expect(await readRun("ann@example.com", run)).toEqual(done);
});

test("eight claims racing for one job: exactly one wins, and a late report cannot rewrite the end", async () => {
  await worker?.close(); // its sweep would be a ninth racer
  worker = undefined;
  const doc = await aDocument("ann@example.com");
  const run = await db.db.forOrg(doc.orgId).createRun({ documentId: doc.id, instruction: "race", createdBy: undefined });
  if (typeof run !== "object") throw new Error("unreachable");
  const key = { queue: "ai" as const, jobId: run.id, orgId: run.orgId };
  const jobs = db.db.jobStore();
  expect(await jobs.claim({ ...key, orgId: doc.id })).toBeUndefined(); // the wrong org names nothing
  const claims = await Promise.all(Array.from({ length: 8 }, () => jobs.claim(key)));
  expect(claims.filter(Boolean)).toEqual([{ id: run.id, orgId: run.orgId, documentId: doc.id, queue: "ai", input: { instruction: "race" }, attempt: 1 }]);

  await jobs.finish(key, "succeeded");
  const done = await readRun("ann@example.com", run);
  expect(done.status).toBe("succeeded");
  await jobs.finish(key, "failed", "late");
  expect(await jobs.claim(key)).toBeUndefined();
  expect(await readRun("ann@example.com", run)).toEqual(done);
});

test("a reason that is not a plain name never reaches the user, and cannot leave the job running", async () => {
  await work(60_000);
  const doc = await aDocument("ann@example.com");
  for (const bad of ["Request req_123 to https://api.example.com failed: prompt was 'secret'", `nul${String.fromCharCode(0)}byte`, "", "x".repeat(300)]) {
    ai = () => Promise.reject(new JobFailure(bad));
    expect(await terminal("ann@example.com", await startRun("ann@example.com", doc, "x")), JSON.stringify(bad)).toMatchObject({ status: "failed", error: "internal" });
  }
});

test("a document has one unfinished run at a time: the second is a 409, and a finished run frees the document", async () => {
  const doc = await aDocument("ann@example.com");
  let release = (): void => undefined;
  ai = () => new Promise<undefined>((resolve) => { release = () => { resolve(undefined); }; });
  const first = await startRun("ann@example.com", doc, "slow");
  const racing = await Promise.all(Array.from({ length: 5 }, () => as("ann@example.com", "POST", `/documents/${doc.id}/runs`, { instruction: "me too" })));
  for (const res of racing) {
    expect(res.status).toBe(409);
    expect(ErrorBody.parse(await res.json())).toEqual({ error: "run_in_progress" });
  }
  expect(await count("select count(*)::int as n from jobs where document_id = $1", [doc.id])).toBe(1);
  // Another document is not held up by this one.
  ai = record;
  expect((await terminal("ann@example.com", await startRun("ann@example.com", await aDocument("ann@example.com"), "elsewhere"))).status).toBe("succeeded");
  release();
  expect((await terminal("ann@example.com", first)).status).toBe("succeeded");
  expect((await as("ann@example.com", "POST", `/documents/${doc.id}/runs`, { instruction: "next" })).status).toBe(201);
});

test("a job of another queue neither stops the sweep nor can be started by a message on the ai queue", async () => {
  await worker?.close();
  worker = undefined;
  ai = record;
  const doc = await aDocument("ann@example.com");
  // Older than everything else, so it sorts first in the sweep.
  const git = ((await db.rawQuery("insert into jobs (org_id, document_id, queue, input, created_at) values ($1, $2, 'git', '{}', now() - interval '1 day') returning id", [doc.orgId, doc.id])) as { rows: { id: string }[] }).rows[0]?.id ?? "";
  const lost = await db.db.forOrg(doc.orgId).createRun({ documentId: doc.id, instruction: "behind a git job", createdBy: undefined });
  if (typeof lost !== "object") throw new Error("unreachable");
  await work(50);
  expect((await terminal("ann@example.com", lost)).status).toBe("succeeded");

  expect(await db.db.jobStore().claim({ queue: "ai", jobId: git, orgId: doc.orgId })).toBeUndefined();
  await producer.enqueue({ queue: "ai", jobId: git, orgId: doc.orgId });
  await new Promise((r) => setTimeout(r, 200));
  expect(await count("select count(*)::int as n from jobs where id = $1 and status = 'queued' and started_at is null", [git])).toBe(1);
});

// --- E4.2b: the sandbox queue has its own concurrency, and a process drains only what it handles ---

const sandboxJob = async (doc: Document): Promise<string> =>
  ((await db.rawQuery("insert into jobs (org_id, document_id, queue, input) values ($1, $2, 'sandbox', '{}') returning id", [doc.orgId, doc.id])) as { rows: { id: string }[] }).rows[0]?.id ?? "";

test("a full ai queue does not hold up a sandbox job: each queue has its own concurrency", async () => {
  await worker?.close();
  const release = new AbortController();
  // An AI run that holds its only slot until the test lets go.
  const holding: AiHandler = (_job, cancelled) => new Promise((resolve) => {
    const done = (): void => { resolve(undefined); };
    release.signal.addEventListener("abort", done);
    cancelled.addEventListener("abort", done);
  });
  let sandboxStarted = 0;
  worker = await startWorker({ db: db.db, redisUrl: TEST_REDIS_URL, prefix, sweepMs: 50, cancelPollMs: 100, concurrency: { ai: 1, sandbox: 2 }, handlers: {
    ai: holding,
    sandbox: () => { sandboxStarted++; return Promise.resolve(undefined); },
  } });
  try {
    const [a, b, c] = [await aDocument("ann@example.com"), await aDocument("ann@example.com"), await aDocument("ann@example.com")];
    const first = await startRun("ann@example.com", a, "hold the slot");
    const second = await startRun("ann@example.com", b, "wait behind it");
    for (let i = 0; i < 100 && (await readRun("ann@example.com", first)).status !== "running"; i++) await new Promise((r) => setTimeout(r, 20));
    const job = await sandboxJob(c);
    for (let i = 0; i < 100 && sandboxStarted === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sandboxStarted).toBe(1);
    // The handler has been CALLED; the worker writes the outcome after it resolves. Wait for the row.
    const succeeded = async (): Promise<number | undefined> => count("select count(*)::int as n from jobs where id = $1 and status = 'succeeded'", [job]);
    for (let i = 0; i < 100 && (await succeeded()) !== 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await succeeded()).toBe(1);
    expect((await readRun("ann@example.com", second)).status).toBe("queued"); // the ai slot really was full
  } finally {
    release.abort();
    await worker.close();
    worker = undefined;
  }
});

test("a worker drains only the queues it has handlers for: the AI worker never claims a sandbox job", async () => {
  await worker?.close();
  worker = undefined;
  ai = record;
  const doc = await aDocument("ann@example.com");
  const job = await sandboxJob(doc);
  const aiOnly = await work(50); // handlers: ai only
  await producer.enqueue({ queue: "sandbox", jobId: job, orgId: doc.orgId });
  await new Promise((r) => setTimeout(r, 300)); // several sweeps
  expect(await count("select count(*)::int as n from jobs where id = $1 and status = 'queued' and started_at is null", [job])).toBe(1);
  // A sandbox ref delivered on the AI queue (misrouted, or forged by someone holding the Redis
  // password) must not be claimed and then failed for want of a handler: it stays queued for its own worker.
  const aiQueue = new Queue("ai", { connection: connection(TEST_REDIS_URL), prefix });
  await aiQueue.add("sandbox", { queue: "sandbox", jobId: job, orgId: doc.orgId });
  await aiQueue.close();
  await new Promise((r) => setTimeout(r, 300));
  expect(await count("select count(*)::int as n from jobs where id = $1 and status = 'queued' and started_at is null", [job])).toBe(1);
  await aiOnly.close();
  worker = undefined;
  await db.rawQuery("update jobs set status = 'cancelled', finished_at = now() where id = $1", [job]);
});

// --- E3.3: cancel (F10) ---------------------------------------------------------------------------
const cancel = (user: string, run: Run) => as(user, "POST", `/documents/${run.documentId}/runs/${run.id}/cancel`);

test("cancelling a RUNNING run aborts its handler and ends it as `cancelled` within 3 s; cancelling again changes nothing", async () => {
  await worker?.close();
  await work(60_000);
  const doc = await aDocument("ann@example.com");
  let aborted = false;
  ai = (_job, signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); });
  const run = await startRun("ann@example.com", doc, "slow");
  for (let i = 0; i < 100 && (await readRun("ann@example.com", run)).status !== "running"; i++) await new Promise((r) => setTimeout(r, 20));

  const started = Date.now();
  const res = await cancel("ann@example.com", run);
  expect(res.status).toBe(200);
  expect(Run.parse(await res.json()).status).toBe("running"); // asked, not yet done: the worker ends it
  const done = await terminal("ann@example.com", run);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(done).toMatchObject({ status: "cancelled", error: null });
  expect(aborted).toBe(true);
  expect(Run.parse(await (await cancel("ann@example.com", run)).json())).toEqual(done);
  // The document is free again at once.
  ai = record;
  expect((await terminal("ann@example.com", await startRun("ann@example.com", doc, "next"))).status).toBe("succeeded");
});

test("cancelling a run that is still QUEUED ends it at once, and the worker never starts it", async () => {
  await worker?.close();
  worker = undefined;
  const doc = await aDocument("ann@example.com");
  aiCalls = [];
  ai = record;
  const run = await startRun("ann@example.com", doc, "never started");
  expect(Run.parse(await (await cancel("ann@example.com", run)).json())).toMatchObject({ status: "cancelled", startedAt: null });
  await work(50);
  await new Promise((r) => setTimeout(r, 300));
  expect(aiCalls).toEqual([]);
  expect((await readRun("ann@example.com", run)).status).toBe("cancelled");
});

test("only a member can cancel, and only under the right document: everything else is the same 404", async () => {
  const doc = await aDocument("ann@example.com");
  const other = await aDocument("ann@example.com");
  await worker?.close();
  worker = undefined;
  const run = await startRun("ann@example.com", doc, "mine");
  for (const res of [await cancel("eve@example.com", run), await as("ann@example.com", "POST", `/documents/${other.id}/runs/${run.id}/cancel`), await as("ann@example.com", "POST", `/documents/${doc.id}/runs/${doc.id}/cancel`)]) {
    expect(res.status).toBe(404);
    expect(ErrorBody.parse(await res.json())).toEqual({ error: "not_found" });
  }
  expect((await readRun("ann@example.com", run)).status).toBe("queued");
});

// Found by the E3.3 verify (49 of 50 races): the loser of two cancels at the same moment was told "queued",
// the row as it was BEFORE the winner committed. The answer must be the run as it now is.
test("two people cancel the same queued run at the same moment: both are told it is cancelled", async () => {
  await worker?.close();
  worker = undefined;
  for (let round = 0; round < 15; round++) {
    const doc = await aDocument("ann@example.com");
    const run = await startRun("ann@example.com", doc, "race");
    const answers = await Promise.all([cancel("ann@example.com", run), cancel("ann@example.com", run), cancel("ann@example.com", run)]);
    for (const res of answers) expect(Run.parse(await res.json()).status, `round ${String(round)}`).toBe("cancelled");
  }
});

// --- E3.4: usage (F12) ----------------------------------------------------------------------------
const spent = { model: "claude-test-1", inputTokens: 1200, outputTokens: 340, cacheReadTokens: 9000, cacheWriteTokens: 800, costUsd: 0.012345 };

// integration:usage-recorded-and-readable
test("after a run, its tokens and estimated cost are stored against the org and readable through the org's api, with totals", async () => {
  await worker?.close();
  await work(60_000);
  const doc = await aDocument("usage-ann@example.com");
  ai = () => Promise.resolve(spent);
  const first = await terminal("usage-ann@example.com", await startRun("usage-ann@example.com", doc, "one"));
  const second = await terminal("usage-ann@example.com", await startRun("usage-ann@example.com", doc, "two"));
  ai = () => Promise.reject(new JobFailure("rate_limited")); // nothing to record: the provider never answered
  await terminal("usage-ann@example.com", await startRun("usage-ann@example.com", doc, "three"));

  const res = await as("usage-ann@example.com", "GET", `/orgs/${doc.orgId}/usage`);
  expect(res.status).toBe(200);
  const usage = UsageReport.parse(await res.json());
  expect(usage.totals).toEqual({ runs: 2, inputTokens: 2400, outputTokens: 680, cacheReadTokens: 18000, cacheWriteTokens: 1600, costUsd: 0.02469 });
  expect(usage.items.map((each) => each.runId).sort()).toEqual([first.id, second.id].sort());
  expect(usage.items[0]).toMatchObject({ orgId: doc.orgId, documentId: doc.id, kind: "ai_run", ...spent });
  expect(usage.nextCursor).toBeNull();

  // A message delivered twice must not bill twice, and billing history outlives the document it was for.
  await db.db.jobStore().recordUsage({ queue: "ai", jobId: first.id, orgId: doc.orgId }, spent);
  await db.rawQuery("delete from documents where id = $1", [doc.id]);
  const after = UsageReport.parse(await (await as("usage-ann@example.com", "GET", `/orgs/${doc.orgId}/usage`)).json());
  expect(after.totals).toEqual(usage.totals);
  expect(after.items.map((each) => each.runId)).toEqual([null, null]); // the runs went with the document; what they cost did not
});

// integration:usage-tenant-404
test("another org sees none of it: its own usage is empty, and asking for someone else's org is the usual 404", async () => {
  const mine = await aDocument("usage-bob@example.com");
  ai = () => Promise.resolve(spent);
  await terminal("usage-bob@example.com", await startRun("usage-bob@example.com", mine, "bob's"));
  const theirs = await aDocument("usage-eve@example.com");

  const eveOwn = UsageReport.parse(await (await as("usage-eve@example.com", "GET", `/orgs/${theirs.orgId}/usage`)).json());
  expect(eveOwn).toEqual({ totals: { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, items: [], nextCursor: null });
  const peek = await as("usage-eve@example.com", "GET", `/orgs/${mine.orgId}/usage`);
  expect(peek.status).toBe(404);
  expect(await peek.text()).toBe(await (await as("usage-eve@example.com", "GET", `/orgs/${crypto.randomUUID()}/usage`)).text()); // the same bytes as an org that does not exist
  // The store itself refuses a job under the wrong org: nothing is written.
  const bobs = ((await db.rawQuery("select id from jobs where document_id = $1", [mine.id])) as { rows: { id: string }[] }).rows[0]?.id ?? "";
  await db.rawQuery("delete from usage where job_id = $1", [bobs]);
  await db.db.jobStore().recordUsage({ queue: "ai", jobId: bobs, orgId: theirs.orgId }, spent);
  expect(await count("select count(*)::int as n from usage where job_id = $1", [bobs])).toBe(0);
});
