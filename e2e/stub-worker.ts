// The worker for the e2e layer: the REAL queue, the REAL handler, the REAL peer-client and tools.
// Only the model is scripted, so a browser test never calls (or pays for) a real one. It lives in
// e2e/, not in apps/worker: a scripted model behind an environment switch in the product would be
// one wrong variable away from production.
import { createServer } from "node:http";
import { createDb } from "@noon/db";
import { manifest } from "@noon/design-system";
import { createAiHandler, type RunAgent } from "../apps/worker/src/ai.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import { JobFailure, startWorker } from "../apps/worker/src/worker.ts";

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
});

/**
 * "... N buttons ..." in the instruction = a Card, then N Buttons, one every 400 ms: slow enough to
 * watch them arrive one by one, and to cancel in the middle. "rate limit" = the provider says no.
 */
const scripted: RunAgent = async ({ instruction, tools, signal }) => {
  if (instruction.includes("rate limit")) throw new JobFailure("rate_limited");
  const call = async (name: string, args: unknown): Promise<string> => {
    const result = await tools.find((t) => t.name === name)?.run(args);
    if (!result?.ok) throw new Error(`stub: ${name} failed: ${result?.text ?? "no such tool"}`);
    return result.text;
  };
  const card = (JSON.parse(await call("add_node", { parentId: "root", component: "Card", props: { title: "From the AI" } })) as { nodeId: string }).nodeId;
  const count = Number(/(\d+) buttons/.exec(instruction)?.[1] ?? "3");
  for (let i = 1; i <= count; i++) {
    await sleep(400, signal);
    await call("add_node", { parentId: card, component: "Button", props: { label: `AI ${String(i)}` } });
  }
  return { model: "scripted", inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0123 };
};

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.databaseUrl });
const stopping = new AbortController();
const worker = await startWorker({
  db,
  redisUrl: config.redisUrl,
  sweepMs: 2000,
  cancelPollMs: 500,
  handlers: { ai: createAiHandler({ sessions: config.sessions, manifest, oauthToken: "stub", ready: Promise.resolve(), stopping: stopping.signal, stillMember: async (documentId, userId) => (await db.getDocumentForMember(documentId, userId)) !== undefined, runAgent: scripted }) },
});
// Playwright waits for a URL to answer: this is that URL, and nothing else.
createServer((_, res) => res.end("ready")).listen(Number(process.env["READY_PORT"] ?? "3102"));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { stopping.abort(); void worker.close().then(() => db.close()).finally(() => process.exit(0)); });
