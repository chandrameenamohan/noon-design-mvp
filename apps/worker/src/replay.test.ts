import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ClientOp, type Doc, type Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOp, emptyDoc, validate } from "@noon/doc-model";
import { replayIds } from "./ai.ts";
import { buildTools, type AgentPeer } from "./tools.ts";

// F28: an AI run retried after its worker died replays the dead attempt's steps under the same ids.

const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 0, component: "Stack", props: {} });

test("a run's ids are the same on every attempt of its job, and nobody else's", () => {
  const job = randomUUID();
  const first = replayIds(job);
  const again = replayIds(job);
  const other = replayIds(randomUUID());
  const firstIds = [first.nodeId(), first.nodeId(), first.opId(add("a")), first.opId(add("b"))];
  expect([again.nodeId(), again.nodeId(), again.opId(add("a")), again.opId(add("b"))]).toEqual(firstIds);
  expect(new Set(firstIds).size).toBe(4); // every step its own id
  expect([other.nodeId(), other.nodeId(), other.opId(add("a")), other.opId(add("b"))].filter((id) => firstIds.includes(id))).toEqual([]);
  for (const opId of firstIds.slice(2)) expect(ClientOp.safeParse({ opId, baseSeq: 0, op: add("a") }).success).toBe(true); // what the room will accept
});

test("the op's content is in its id: something else at the same step is a new op, never the old one's answer", () => {
  const job = randomUUID();
  expect(replayIds(job).opId(add("a"))).not.toBe(replayIds(job).opId(add("b")));
  // The step counts too: the same op again later is its own op (a set_prop back and forth is two edits).
  const ids = replayIds(job);
  expect(ids.opId(add("a"))).not.toBe(ids.opId(add("a")));
});

/** The slice of a peer the tools use, holding the document the room would: what a retried attempt sees on its welcome. */
function peerOver(doc: { current: Doc }): AgentPeer & { sent: Op[] } {
  const sent: Op[] = [];
  return {
    sent,
    get doc() { return doc.current; },
    submit(op) {
      const verdict = validate(doc.current, op, manifest);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      doc.current = applyOp(doc.current, op);
      sent.push(op);
      return { ok: true, opId: randomUUID(), settled: Promise.resolve({ ok: true }) };
    },
  };
}
const tool = (tools: ReturnType<typeof buildTools>, name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(name);
  return found;
};

test("a retried attempt that replays add_node finds the dead attempt's nodes: done, and nothing is added twice", async () => {
  const job = randomUUID();
  const doc = { current: emptyDoc() };
  const dead = peerOver(doc);
  const died = buildTools(dead, manifest, replayIds(job).nodeId);
  const one = await tool(died, "add_node").run({ parentId: "root", component: "Stack" });
  const two = await tool(died, "add_node").run({ parentId: "root", component: "Button", props: { label: "Pay" } });
  expect([one.ok, two.ok]).toEqual([true, true]);

  const retry = peerOver(doc);
  const again = buildTools(retry, manifest, replayIds(job).nodeId);
  expect(await tool(again, "add_node").run({ parentId: "root", component: "Stack" })).toEqual(one); // the same answer, the same nodeId
  expect(await tool(again, "add_node").run({ parentId: "root", component: "Button", props: { label: "Pay" } })).toEqual(two);
  expect(retry.sent).toEqual([]); // nothing reached the room
  expect(Object.keys(doc.current.nodes)).toHaveLength(3); // root + the two

  // The retry goes on past where the dead attempt stopped: a new step, a new node.
  expect((await tool(again, "add_node").run({ parentId: "root", component: "Stack" })).ok).toBe(true);
  expect(Object.keys(doc.current.nodes)).toHaveLength(4);
});

test("a retry that does something else at a replayed step is refused there, and its next add gets a fresh id", async () => {
  const job = randomUUID();
  const doc = { current: emptyDoc() };
  await tool(buildTools(peerOver(doc), manifest, replayIds(job).nodeId), "add_node").run({ parentId: "root", component: "Stack" });
  const again = buildTools(peerOver(doc), manifest, replayIds(job).nodeId);
  const changedMind = await tool(again, "add_node").run({ parentId: "root", component: "Button", props: { label: "Pay" } });
  expect(changedMind).toMatchObject({ ok: false, text: expect.stringContaining("duplicate_node") as unknown });
  expect((await tool(again, "add_node").run({ parentId: "root", component: "Button", props: { label: "Pay" } })).ok).toBe(true);
  expect(Object.values(doc.current.nodes).map((n) => n.component).sort()).toEqual(["Button", "Page", "Stack"].sort());
});
