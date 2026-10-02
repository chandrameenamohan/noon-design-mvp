import { expect, test } from "vitest";
import type { UsageAmount } from "@noon/contracts";
import { attemptKey, JobFailure, requireEditor, runAttempt, type Handlers } from "./worker.ts";

// noon-37s: whatever way an attempt ends, what it consumed is recorded ONCE, before the row is finished, and the
// bookkeeping never changes how it ended.
const spend = (costUsd: number): UsageAmount => ({ model: "m", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
const job = { id: "j1", orgId: "o1", documentId: "d1", queue: "ai" as const, input: {}, createdBy: "u1", attempt: 1 };
type Handler = NonNullable<Handlers["ai"]>;

async function attempt(handler: Handler, { recordFails = false, cancelled = false } = {}) {
  const calls: string[] = [];
  const recorded: UsageAmount[] = [];
  const cancel = new AbortController();
  if (cancelled) cancel.abort();
  const jobs = {
    recordUsage: (_key: unknown, amount: UsageAmount) => { calls.push("record"); recorded.push(amount); return recordFails ? Promise.reject(new Error("postgres away")) : Promise.resolve(); },
    finish: (_key: unknown, status: string, reason?: string) => { calls.push(reason === undefined ? `finish ${status}` : `finish ${status} ${reason}`); return Promise.resolve(); },
  };
  await runAttempt({ jobs, key: { queue: "ai", jobId: "j1", orgId: "o1", attempt: 1 }, job, handler, cancel, log: () => undefined });
  return { calls, recorded };
}

test("a run that succeeds records what it returned, once, before it is finished", async () => {
  expect(await attempt((_job, _signal, spent) => { spent(spend(0.1)); return Promise.resolve(spend(0.5)); })).toEqual({ calls: ["record", "finish succeeded"], recorded: [spend(0.5)] });
});

test("a run that fails records what it had spent, and still fails with its own reason", async () => {
  expect(await attempt((_job, _signal, spent) => { spent(spend(0.1)); spent(spend(2)); return Promise.reject(new JobFailure("agent_failed")); })).toEqual({ calls: ["record", "finish failed agent_failed"], recorded: [spend(2)] });
  expect(await attempt((_job, _signal, spent) => { spent(spend(0.3)); return Promise.reject(new Error("boom")); })).toEqual({ calls: ["record", "finish failed internal"], recorded: [spend(0.3)] });
});

test("a cancelled run records what it had spent and ends cancelled", async () => {
  expect(await attempt((_job, _signal, spent) => { spent(spend(0.2)); return Promise.reject(new JobFailure("cancelled")); }, { cancelled: true })).toEqual({ calls: ["record", "finish cancelled"], recorded: [spend(0.2)] });
});

test("a run that spent nothing records nothing", async () => {
  expect(await attempt(() => { return Promise.reject(new JobFailure("token_missing")); })).toEqual({ calls: ["finish failed token_missing"], recorded: [] });
  expect(await attempt(() => Promise.resolve(undefined))).toEqual({ calls: ["finish succeeded"], recorded: [] });
});

test("a usage row that cannot be written never masks how the run ended", async () => {
  expect((await attempt((_job, _signal, spent) => { spent(spend(1)); return Promise.reject(new JobFailure("rate_limited")); }, { recordFails: true })).calls).toEqual(["record", "finish failed rate_limited"]);
  expect((await attempt(() => Promise.resolve(spend(1)), { recordFails: true })).calls).toEqual(["record", "finish succeeded"]);
});

// noon-wv8.6.2: whatever a handler reports goes under the attempt that holds the job. Without it the fence is off,
// and a slow attempt 1 could write its output over attempt 2's (Ship's {commit, pr}) while the job runs.
test("a handler's writes are keyed by the job AND its attempt", () => {
  expect(attemptKey({ ...job, queue: "ship", attempt: 2 })).toEqual({ queue: "ship", jobId: "j1", orgId: "o1", attempt: 2 });
});

// noon-dtf.2.4, noon-87s: a job that edits for someone (an AI run, a Ship) starts only while they may still edit.
test("a job acting for someone starts only if they are still an editor or owner, and names why not", () => {
  for (const role of ["editor", "owner"] as const) expect(() => { requireEditor(role); }).not.toThrow();
  expect(() => { requireEditor("viewer"); }).toThrow(expect.objectContaining({ reason: "forbidden" }) as Error);
  expect(() => { requireEditor(undefined); }).toThrow(expect.objectContaining({ reason: "owner_missing" }) as Error);
});
