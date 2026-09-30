import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Job } from "@noon/db";
import { manifest } from "@noon/design-system";
import { connect, TEST_ORG, TEST_SECRET, useSyncServer } from "../../sync/src/testing.ts";
import { createAiHandler, type RunAgent } from "./ai.ts";
import type { AgentTool } from "./tools.ts";

// integration:agent-adds-node-stub. The REAL sync server and the REAL peer-client; only the model is
// scripted: a stub that calls our tools the way the SDK would, with whatever a model might send.
const ctx = useSyncServer();
const job = (instruction = "add a card"): Job => ({ id: randomUUID(), orgId: TEST_ORG, documentId: randomUUID(), queue: "ai", input: { instruction }, createdBy: randomUUID() });
const usage = { model: "stub", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const never = new AbortController().signal;
const base = () => ({ sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest, oauthToken: "stub", ready: Promise.resolve(), stillMember: () => Promise.resolve(true), stopping: new AbortController().signal, report: () => Promise.resolve() });
const handlerWith = (runAgent: RunAgent) => createAiHandler({ ...base(), runAgent });
/** A model that never finishes by itself: it ends only when the run's signal says so, as the real SDK does. */
const forever: RunAgent = ({ signal }) => new Promise((_, reject) => { signal.addEventListener("abort", () => { reject(new Error("aborted")); }); });
const call = (tools: AgentTool[], name: string, args: unknown) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args);
};

test("the agent's ops reach the room as actor.kind=agent with the run id, one by one, through peer-client", async () => {
  const run = job();
  const human = await connect(ctx.server.url, run.documentId);
  let seenInstruction = "";
  await handlerWith(async ({ instruction, tools }) => {
    seenInstruction = instruction;
    const card = await call(tools, "add_node", { parentId: "root", component: "Card", props: {} });
    expect(card.ok).toBe(true);
    const cardId = /"nodeId":"([^"]+)"/.exec(card.text)?.[1] ?? "";
    expect((await call(tools, "add_node", { parentId: cardId, component: "Button", props: { label: "Pay" } })).ok).toBe(true);
    expect((await call(tools, "set_prop", { nodeId: cardId, key: "title", value: "Payment" })).ok).toBe(true);
    const tree = await call(tools, "read_tree", {});
    expect(tree.text).toContain("Payment"); // it reads what it wrote
    expect((await call(tools, "read_manifest", {})).text).toContain("Button");
    return usage;
  })(run, never);

  expect(seenInstruction).toBe("add a card");
  const first = await human.next("op");
  expect(first).toMatchObject({ seq: 1, actor: { kind: "agent", id: run.createdBy, runId: run.id }, op: { type: "add_node", component: "Card" } });
  expect(await human.next("op")).toMatchObject({ seq: 2, actor: { kind: "agent", runId: run.id }, op: { type: "add_node", component: "Button", props: { label: "Pay" } } });
  expect(await human.next("op")).toMatchObject({ seq: 3, op: { type: "set_prop", key: "title", value: "Payment" } });
  await human.next("presence_left"); // the run is over: the AI has left the document
  human.close();
});

test("an invalid op comes back as a TOOL ERROR that names the reason; nothing reaches the room, and the agent can carry on (F11)", async () => {
  const run = job();
  const human = await connect(ctx.server.url, run.documentId);
  const results: Record<string, { ok: boolean; text: string }> = {};
  await handlerWith(async ({ tools }) => {
    results["unknown component"] = await call(tools, "add_node", { parentId: "root", component: "Widget", props: {} });
    results["unknown prop"] = await call(tools, "add_node", { parentId: "root", component: "Button", props: { colour: "red" } });
    results["no such parent"] = await call(tools, "add_node", { parentId: "nowhere", component: "Card", props: {} });
    results["root is fixed"] = await call(tools, "remove_node", { nodeId: "root" });
    results["not what the schema says"] = await call(tools, "move_node", { nodeId: 7 });
    results["reserved name"] = await call(tools, "set_prop", { nodeId: "root", key: "__proto__", value: "x" });
    results["then a good one"] = await call(tools, "add_node", { parentId: "root", component: "Card", props: {} });
    return usage;
  })(run, never);

  expect(results["unknown component"]).toMatchObject({ ok: false, text: expect.stringContaining("unknown_component") as string });
  expect(results["unknown component"]?.text).toContain("Card"); // and what WOULD be valid
  expect(results["unknown prop"]).toMatchObject({ ok: false, text: expect.stringContaining("unknown_prop") as string });
  expect(results["no such parent"]).toMatchObject({ ok: false, text: expect.stringContaining("gone") as string });
  expect(results["root is fixed"]).toMatchObject({ ok: false, text: expect.stringContaining("root_is_fixed") as string });
  expect(results["not what the schema says"]?.ok).toBe(false);
  expect(results["reserved name"]?.ok).toBe(false);
  expect(results["then a good one"]?.ok).toBe(true);
  expect(await human.next("op")).toMatchObject({ seq: 1, op: { component: "Card" } }); // the ONLY op the room ever saw
  human.close();
});

test("an op the ROOM refuses (the document is full) is a tool error too, not a silent success", async () => {
  // A room of its own with a tiny limit: the replica's local check passes, the server says no.
  const { startSyncServer } = await import("../../sync/src/server.ts");
  const small = await startSyncServer({ port: 0, secrets: [TEST_SECRET], limits: { maxNodes: 2 } });
  try {
    const results: { ok: boolean; text: string }[] = [];
    await createAiHandler({ ...base(), sessions: { secret: TEST_SECRET, syncUrl: small.url }, runAgent: async ({ tools }) => {
      results.push(await call(tools, "add_node", { parentId: "root", component: "Card", props: {} }));
      results.push(await call(tools, "add_node", { parentId: "root", component: "Card", props: {} }));
      return usage;
    } })(job(), never);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]?.text).toContain("document_limit");
  } finally {
    await small.close();
  }
});

test.each([
  ["no token", () => ({ oauthToken: undefined }), "token_missing"],
  ["the startup probe failed", () => ({ ready: Promise.reject(new Error("tools_missing")) }), "tools_missing"],
  ["the sync server cannot be reached", () => ({ sessions: { secret: TEST_SECRET, syncUrl: "ws://127.0.0.1:1" } }), "sync_unreachable"],
  ["the user who started it no longer exists", () => ({}), "owner_missing"],
  ["the user who started it has since been removed from the org", () => ({ stillMember: () => Promise.resolve(false) }), "owner_missing"],
] as const)("the run fails fast with a NAME when %s: the model is never called and the document is never even opened", async (label, override, reason) => {
  let called = false;
  const handler = createAiHandler({ ...base(), connectTimeoutMs: 500, runAgent: () => { called = true; return Promise.resolve(usage); }, ...override() });
  // integration:ai-token-missing-fails-fast is the first row; the others are its relatives.
  const run = label.includes("no longer exists") ? { ...job(), createdBy: undefined } : job();
  await expect(handler(run, never)).rejects.toMatchObject({ reason });
  expect(called).toBe(false);
  expect(ctx.server.peerCount(run.documentId)).toBe(0); // an unchanged tree, because nobody ever joined it
});

test("when the agent throws, the peer still leaves the document", async () => {
  const run = job();
  const human = await connect(ctx.server.url, run.documentId);
  await expect(handlerWith(() => Promise.reject(new Error("model exploded")))(run, never)).rejects.toThrow("model exploded");
  await human.next("presence_left");
  human.close();
});

// --- From the E3.2 review: nothing bounded a run once it was connected. A run that never ends holds one of
// four worker slots for ever, and its `running` row blocks that document's next run for ever (409). ---
test("a run that outlives its deadline is ended as `timed_out`: the model is aborted and the peer leaves", async () => {
  const run = job();
  const human = await connect(ctx.server.url, run.documentId);
  let aborted = false;
  const started = Date.now();
  await expect(createAiHandler({ ...base(), runTimeoutMs: 300, runAgent: (input) => { input.signal.addEventListener("abort", () => { aborted = true; }); return forever(input); } })(run, never)).rejects.toMatchObject({ reason: "timed_out" });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(aborted).toBe(true);
  await human.next("presence_left");
  human.close();
});

test("a worker that is told to stop ends its run as `worker_stopped` at once, so the row never stays `running`", async () => {
  const stopping = new AbortController();
  const running = createAiHandler({ ...base(), stopping: stopping.signal, runAgent: forever })(job(), never);
  setTimeout(() => { stopping.abort(); }, 100);
  const started = Date.now();
  await expect(running).rejects.toMatchObject({ reason: "worker_stopped" });
  expect(Date.now() - started).toBeLessThan(1500);
  // And a worker that is ALREADY stopping starts nothing.
  await expect(createAiHandler({ ...base(), stopping: stopping.signal, runAgent: () => { throw new Error("must not be called"); } })(job(), never)).rejects.toMatchObject({ reason: "worker_stopped" });
});

test("when the sync server goes away in the middle of a run, the waiting tool call comes back as an error and the run ends as `sync_unreachable`", async () => {
  const { startSyncServer } = await import("../../sync/src/server.ts");
  const doomed = await startSyncServer({ port: 0, secrets: [TEST_SECRET] });
  let toolResult: { ok: boolean; text: string } | undefined;
  const running = createAiHandler({ ...base(), sessions: { secret: TEST_SECRET, syncUrl: doomed.url }, connectTimeoutMs: 600, runAgent: async ({ tools, signal }) => {
    expect((await call(tools, "add_node", { parentId: "root", component: "Card", props: {} })).ok).toBe(true);
    await doomed.close();
    toolResult = await call(tools, "add_node", { parentId: "root", component: "Card", props: {} }); // no server will ever answer this one
    return forever({ instruction: "", tools, signal });
  } })(job(), never);
  await expect(running).rejects.toMatchObject({ reason: "sync_unreachable" });
  expect(toolResult).toMatchObject({ ok: false, text: expect.stringContaining("connection_closed") as string });
});

test("hostile or sloppy arguments: a `__proto__` prop is refused (not silently dropped), and props may be left out", async () => {
  const results: { ok: boolean; text: string }[] = [];
  await handlerWith(async ({ tools }) => {
    results.push(await call(tools, "add_node", JSON.parse('{"parentId":"root","component":"Card","props":{"__proto__":{"polluted":true}}}')));
    results.push(await call(tools, "add_node", { parentId: "root", component: "Card" }));
    return usage;
  })(job(), never);
  expect(results[0]).toMatchObject({ ok: false, text: expect.stringContaining("invalid_arguments") as string });
  expect(results[1]?.ok).toBe(true);
  // A model can nest deeper than the stack goes (about 10,000 levels fit in one output). A tool never throws: it answers.
  let deep: unknown = "x";
  for (let i = 0; i < 20_000; i++) deep = { n: deep };
  const tools = (await import("./tools.ts")).buildTools({ submit: () => ({ ok: false, reason: "not_ready" }), get doc(): never { throw new Error("unused"); } }, manifest);
  expect(await call(tools, "add_node", { parentId: "root", component: "Card", props: deep })).toMatchObject({ ok: false, text: expect.stringContaining("invalid_arguments") as string });
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

// Found by the E3.2 re-verify: the wait for "live" polled every 20 ms and nobody stopped it. A run that
// ended BEFORE its peer connected (sync down at the start) left that loop ticking for the life of the worker.
test("a run that ends before its peer ever connects leaves no timer behind", async () => {
  const handler = createAiHandler({ ...base(), sessions: { secret: TEST_SECRET, syncUrl: "ws://127.0.0.1:1" }, connectTimeoutMs: 150, runAgent: forever });
  await expect(handler(job(), never)).rejects.toMatchObject({ reason: "sync_unreachable" });
  const real = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { scheduled++; return real(...args); }) as typeof setTimeout;
  try {
    await new Promise((r) => real(r, 300));
  } finally {
    globalThis.setTimeout = real;
  }
  expect(scheduled).toBe(0);
});

test("a cancelled run ends as `cancelled` at once: the model is aborted, the ops already applied stay, the AI leaves (F10)", async () => {
  const run = job();
  const human = await connect(ctx.server.url, run.documentId);
  const cancelled = new AbortController();
  const running = createAiHandler({ ...base(), runAgent: async (input) => {
    expect((await call(input.tools, "add_node", { parentId: "root", component: "Card" })).ok).toBe(true);
    cancelled.abort();
    return forever(input);
  } })(run, cancelled.signal);
  await expect(running).rejects.toMatchObject({ reason: "cancelled" });
  expect(await human.next("op")).toMatchObject({ seq: 1, op: { component: "Card" } }); // it stays
  await human.next("presence_left");
  human.close();
});
