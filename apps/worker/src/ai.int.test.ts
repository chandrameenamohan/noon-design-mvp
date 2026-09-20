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
const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
const handlerWith = (runAgent: RunAgent) => createAiHandler({ sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest, oauthToken: "stub", runAgent, ready: Promise.resolve() });
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
  })(run);

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
  })(run);

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
    await createAiHandler({ sessions: { secret: TEST_SECRET, syncUrl: small.url }, manifest, oauthToken: "stub", ready: Promise.resolve(), runAgent: async ({ tools }) => {
      results.push(await call(tools, "add_node", { parentId: "root", component: "Card", props: {} }));
      results.push(await call(tools, "add_node", { parentId: "root", component: "Card", props: {} }));
      return usage;
    } })(job());
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
] as const)("the run fails fast with a NAME when %s, and the model is never called", async (label, override, reason) => {
  let called = false;
  const handler = createAiHandler({ sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest, oauthToken: "stub", ready: Promise.resolve(), connectTimeoutMs: 500, runAgent: () => { called = true; return Promise.resolve(usage); }, ...override() });
  await expect(handler(label.startsWith("the user") ? { ...job(), createdBy: undefined } : job())).rejects.toMatchObject({ reason });
  expect(called).toBe(false);
});

test("when the agent throws, the peer still leaves the document", async () => {
  const run = job();
  const human = await connect(ctx.server.url, run.documentId);
  await expect(handlerWith(() => Promise.reject(new Error("model exploded")))(run)).rejects.toThrow("model exploded");
  await human.next("presence_left");
  human.close();
});
