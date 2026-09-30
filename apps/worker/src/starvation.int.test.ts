import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { generate } from "@noon/codegen";
import type { Doc, Op, ServerMessage } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOp, emptyDoc } from "@noon/doc-model";
import { TEST_REDIS_URL } from "../../../packages/queue/src/testing.ts";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { connect, TEST_SECRET, useSyncServer, type TestPeer } from "../../sync/src/testing.ts";
import { createAiHandler, type RunAgent } from "./ai.ts";
import { createGitPeer } from "./git.ts";
import { git, localOrigin, type LocalOrigin } from "./git-testing.ts";
import { createPushApplier } from "./push.ts";
import { pagePath } from "./sandbox.ts";
import { startWorker, type RunningWorker } from "./worker.ts";

// integration:no-starvation-under-saturation (E9.2a, SPEC F29). The ai queue is full: as many long AI runs as its
// concurrency, each editing its document all the time (one of them the document an engineer is about to push to),
// and more runs waiting behind them. A push must still reach the open canvas in under 5 s. Everything here is real
// but the model: the worker and its queue (Redis), the AI handler and its peer, the sync server, the git peer with
// its production poll (1 s) and git itself. They even share ONE process and event loop, which production does not
// give them (the git peer is its own service): if the push gets through here, it gets through there.
const prefix = `test-${randomBytes(6).toString("hex")}`;
const CONCURRENCY = 2;
const ctx = useSyncServer();
let t: TestDb, local: LocalOrigin, worker: RunningWorker | undefined, gitPeer: { stop(): Promise<void> } | undefined;
const stopping = new AbortController();

beforeAll(async () => {
  t = await createTestDb();
  local = await localOrigin("noon-starve-");
});
afterAll(async () => {
  stopping.abort(); // every stub run ends as worker_stopped
  await worker?.close();
  await gitPeer?.stop();
  local.remove();
  await t.drop();
});

/** A long AI run that is busy the whole time: an edit every 200 ms through the real tools, until it is stopped. */
const busyAgent: RunAgent = async ({ tools, signal }) => {
  const add = tools.find((each) => each.name === "add_node");
  if (!add) throw new Error("no add_node tool");
  while (!signal.aborted) {
    await add.run({ parentId: "root", component: "Stack" });
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("stopped");
};

test("with the ai queue saturated by long runs, one on the pushed document, a push reaches the canvas in under 5 s", async () => {
  const user = await t.db.upsertUser({ email: "starve@example.com", name: "Eng" });
  const org = await t.createOrg("Starvation");
  const ws = await t.db.forOrg(org.id).createWorkspace({ name: "ws" });
  const documents = await Promise.all(Array.from({ length: CONCURRENCY + 2 }, async (_, i) => {
    const d = await t.db.forOrg(org.id).createDocument({ workspaceId: ws.id, title: `doc ${String(i)}` });
    if (!d) throw new Error("unreachable");
    return d.id;
  }));
  const pushed = documents[0] ?? "";
  const branch = `noon/${pushed}`;

  // The canvas: a person in the pushed document, holding one Button.
  const person: TestPeer = await connect(ctx.server.url, pushed, user.id, {}, org.id);
  const button: Op = { type: "add_node", nodeId: "b1", parentId: "root", index: 0, component: "Button", props: { label: "Before" } };
  const opId = person.send(button);
  await person.next("op", (m) => m.opId === opId);
  const base: Doc = applyOp(emptyDoc(), button);
  const fileOf = (page: Doc): string => {
    const generated = generate(page, manifest);
    if (!generated.ok) throw new Error(generated.reason);
    return generated.tsx;
  };

  // The git peer, as main.ts runs it. The branch's first push (the page as it is) gives the next push its base.
  const store = t.db.gitStore();
  const toOps = createPushApplier({ sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest, documentOrg: (id) => Promise.resolve(id === pushed ? org.id : undefined), shippedCommit: (sha) => store.shippedCommit(sha) });
  const peer = createGitPeer({ seed: { url: local.origin }, dir: join(local.root, "peer"), store, log: () => undefined, apply: async (event, page, pageBase) => { await toOps(event, page, pageBase); } });
  gitPeer = await peer.start({ pollMs: 1000, reconcileMs: 30_000 });
  /** An engineer's push, and the webhook the api would record for it. */
  const push = async (page: Doc, before: string): Promise<string> => {
    const after = await local.commit({ [pagePath(pushed)]: fileOf(page) }, "edit the page", branch, true);
    await store.record({ ref: `refs/heads/${branch}`, before, after });
    return after;
  };
  const statusOf = async (sha: string): Promise<string | undefined> => ((await t.rawQuery("select status from git_events where after_sha = $1", [sha])) as { rows: { status: string }[] }).rows[0]?.status;
  const first = await push(base, await git(local.work, "rev-parse", "HEAD")); // the branch starts from main's seed commit
  for (let i = 0; (await statusOf(first)) !== "done"; i++) {
    if (i > 200) throw new Error("the first push was never handled");
    await new Promise((r) => setTimeout(r, 50));
  }

  // Saturate: CONCURRENCY + 2 runs, the pushed document's first, on a worker that takes CONCURRENCY at once.
  for (const documentId of documents) {
    await t.rawQuery("insert into jobs (org_id, document_id, queue, input, created_by) values ($1, $2, 'ai', $3, $4)", [org.id, documentId, JSON.stringify({ instruction: "keep busy" }), user.id]);
    await new Promise((r) => setTimeout(r, 5)); // created_at orders the sweep
  }
  const ai = createAiHandler({ sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest, oauthToken: "stub", runAgent: busyAgent, ready: Promise.resolve(), stillMember: () => Promise.resolve(true), stopping: stopping.signal });
  worker = await startWorker({ db: t.db, redisUrl: TEST_REDIS_URL, prefix, handlers: { ai }, concurrency: { ai: CONCURRENCY }, sweepMs: 5000 });
  const byStatus = async (): Promise<Record<string, number>> => Object.fromEntries(((await t.rawQuery("select status, count(*)::int as n from jobs where org_id = $1 group by status", [org.id])) as { rows: { status: string; n: number }[] }).rows.map((r) => [r.status, r.n]));
  const agentOps = (): number => person.inbox.filter((m) => m.type === "op" && m.actor.kind === "agent").length;
  for (let i = 0; agentOps() < 5; i++) {
    if (i > 400) throw new Error("the AI run on the pushed document never got going");
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(await byStatus()).toEqual({ running: CONCURRENCY, queued: 2 }); // saturated: every slot busy, runs waiting

  // The push, mid-run.
  const pushedAt = Date.now();
  const gitOp = (m: ServerMessage): boolean => m.type === "op" && m.actor.kind === "git" && m.op.type === "set_prop";
  await push(applyOp(base, { type: "set_prop", nodeId: "b1", key: "label", value: "From git" }), first);
  while (!person.inbox.some(gitOp)) {
    if (Date.now() - pushedAt > 5000) throw new Error(`the push did not reach the canvas within 5 s; jobs: ${JSON.stringify(await byStatus())}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  const tookMs = Date.now() - pushedAt;
  expect(tookMs).toBeLessThan(5000);
  expect(person.inbox.find(gitOp)).toMatchObject({ op: { type: "set_prop", nodeId: "b1", key: "label", value: "From git" } });
  // And the AI was really working the whole time: its edits kept arriving after the push landed.
  const before = agentOps();
  await new Promise((r) => setTimeout(r, 1000));
  expect(agentOps()).toBeGreaterThan(before);
  expect(await byStatus()).toEqual({ running: CONCURRENCY, queued: 2 });
  person.close();
}, 60_000);
