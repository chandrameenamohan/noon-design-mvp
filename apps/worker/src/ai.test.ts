import { expect, test } from "vitest";
import type { Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { emptyDoc } from "@noon/doc-model";
import { createAiHandler, stopOnForbidden } from "./ai.ts";
import type { AgentPeer } from "./tools.ts";

// noon-dtf.2.4: a run acts for its creator, so it runs only while they may EDIT the document. The room refuses a
// viewer's every op; a run that went on anyway would spend tokens on edits that can never land. The real room is
// ai.int.test.ts.
const never = new AbortController().signal;
const job = { id: "j1", orgId: "o1", documentId: "d1", queue: "ai" as const, input: { instruction: "add a card" }, createdBy: "u1" };
const usage = { model: "stub", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const handlerAs = (role: "owner" | "editor" | "viewer" | undefined, called: { model: boolean }) => createAiHandler({
  sessions: { secret: "s".repeat(40), syncUrl: "ws://127.0.0.1:1" }, manifest, oauthToken: "stub", ready: Promise.resolve(), stopping: new AbortController().signal, report: () => Promise.resolve(),
  roleOf: () => Promise.resolve(role), connectTimeoutMs: 200,
  runAgent: () => { called.model = true; return Promise.resolve(usage); },
});

test.each([
  ["has since been made a viewer", "viewer", "forbidden"],
  ["is no longer a member of the org", undefined, "owner_missing"],
] as const)("a run whose creator %s fails as %s before the model is called", async (_label, role, reason) => {
  const called = { model: false };
  await expect(handlerAs(role, called)(job, never)).rejects.toMatchObject({ reason });
  expect(called.model).toBe(false);
});

test("a run whose creator is still an editor or owner goes on to open the document", async () => {
  for (const role of ["editor", "owner"] as const) {
    // Nothing answers at that address: getting as far as `sync_unreachable` means the role check let it through.
    await expect(handlerAs(role, { model: false })(job, never)).rejects.toMatchObject({ reason: "sync_unreachable" });
  }
});

const op: Op = { type: "remove_node", nodeId: "n1" };
const peerAnswering = (outcome: { ok: true } | { ok: false; reason: "forbidden" | "gone" }): AgentPeer => ({
  doc: emptyDoc(),
  submit: () => ({ ok: true, opId: "op1", settled: Promise.resolve(outcome) }),
});

test("the room's first `forbidden` (the creator was made a viewer mid-run) stops the run; any other answer does not", async () => {
  const stops: string[] = [];
  for (const outcome of [{ ok: true }, { ok: false, reason: "gone" }, { ok: false, reason: "forbidden" }] as const) {
    const submitted = stopOnForbidden(peerAnswering(outcome), () => { stops.push(outcome.ok ? "ok" : outcome.reason); }).submit(op);
    expect(submitted.ok && (await submitted.settled)).toEqual(outcome); // the tool still hears the room's own answer
  }
  expect(stops).toEqual(["forbidden"]);
});
