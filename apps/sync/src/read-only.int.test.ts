import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Actor, Op, SequencedOp } from "@noon/contracts";
import type { DocumentStore } from "@noon/db";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { connectPeer } from "@noon/peer-client";
import { signSessionToken } from "@noon/session-token";
import { startSyncServer } from "./server.ts";
import { TEST_ORG, TEST_SECRET, until } from "./testing.ts";

// E6.1b over real sockets, with a journal whose outage the test controls: the room goes read-only, every
// kind of peer (a person, the AI, the git peer) hears it through the contract, and it recovers by itself.
// scripts/chaos/postgres-down-read-only.ts is the same story against the real compose stack and Postgres.
const add = (nodeId: string): Op => ({ type: "add_node", nodeId, parentId: ROOT_ID, index: 0, component: "Stack", props: {} });

/** op_journal in memory, with its two unique keys. `down`: every call refuses. `hang`: every call waits for ever. */
function switchableStore() {
  const rows: SequencedOp[] = [];
  const state = { down: false, hang: false };
  const gate = <T>(work: () => T): Promise<T> =>
    state.hang ? new Promise<T>(() => undefined) : state.down ? Promise.reject(new Error("connection refused")) : Promise.resolve(work());
  const store: DocumentStore = {
    load: () => gate(() => ({ doc: undefined, seq: 0, snapshotSeq: 0 })),
    snapshotted: () => gate(() => undefined),
    fence: () => gate(() => 0),
    claim: () => gate(() => true),
    append: (_org, _doc, op) => gate(() => {
      const original = rows.find((r) => r.actor.id === op.actor.id && r.opId === op.opId);
      if (original) return original;
      if (rows.some((r) => r.seq === op.seq)) throw new Error("op_journal_seq");
      rows.push(op);
      return undefined;
    }),
    find: (_org, _doc, actorId, opId) => gate(() => rows.find((r) => r.actor.id === actorId && r.opId === opId)),
    everAdded: (_org, _doc, nodeId) => gate(() => rows.some((r) => r.op.type === "add_node" && r.op.nodeId === nodeId)),
    since: (_org, _doc, seq) => gate(() => rows.filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq)),
  };
  return { store, rows, state };
}

function peerAs(url: string, documentId: string, actor: { kind: Actor["kind"]; runId?: string }) {
  const userId = randomUUID();
  return connectPeer({
    manifest,
    session: () => Promise.resolve({ wsUrl: `${url}/documents/${documentId}`, token: signSessionToken({ userId, orgId: TEST_ORG, documentId, secret: TEST_SECRET, ttlSeconds: 60, actor }) }),
    retryMs: { min: 20, max: 100 },
  });
}

// integration:read-only-reaches-every-peer
test("storage down: every peer (person, AI, git) shows read-only, no op is acknowledged; storage back: all writable, the held op lands once", async () => {
  const { store, rows, state } = switchableStore();
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store, recoverMs: 50 });
  try {
    const documentId = randomUUID();
    const person = peerAs(server.url, documentId, { kind: "user" });
    const ai = peerAs(server.url, documentId, { kind: "agent", runId: randomUUID() });
    const git = peerAs(server.url, documentId, { kind: "git", runId: "b".repeat(40) });
    const all = [person, ai, git];
    await until(() => all.every((p) => p.status === "live"), "all three live");
    const first = person.submit(add("before"));
    expect(first.ok && (await first.settled)).toMatchObject({ ok: true, seq: 1 });

    state.down = true;
    const held = person.submit(add("during"));
    await until(() => all.every((p) => p.readOnly), "every peer read-only");
    expect(ai.submit(add("ai-during"))).toEqual({ ok: false, reason: "read_only" });
    expect(git.submit(add("git-during"))).toEqual({ ok: false, reason: "read_only" });
    await new Promise((resolve) => setTimeout(resolve, 200)); // several recover() attempts, all refused
    expect(person.pendingCount).toBe(1); // held, not lost
    expect(all.every((p) => p.status === "live" && p.readOnly)).toBe(true); // no reconnect storm, still read-only
    expect(rows.map((r) => r.seq)).toEqual([1]);

    state.down = false;
    await until(() => all.every((p) => !p.readOnly), "every peer writable again", 3000);
    expect(held.ok && (await held.settled)).toMatchObject({ ok: true, seq: 2 });
    await until(() => all.every((p) => p.seq === 2), "every peer at seq 2");
    expect(rows.map((r) => [r.seq, r.op.type === "add_node" ? r.op.nodeId : ""])).toEqual([[1, "before"], [2, "during"]]);
    for (const p of all) expect(Object.keys(p.confirmed.nodes).sort()).toEqual(["before", "during", ROOT_ID].sort());
    for (const p of all) p.close();
  } finally {
    await server.close();
  }
});

// integration:read-only-on-hung-journal
test("a journal that HANGS (a paused database) turns the room read-only after journalTimeoutMs, and it recovers when the journal answers", async () => {
  const { store, rows, state } = switchableStore();
  const server = await startSyncServer({ port: 0, secrets: [TEST_SECRET], store, journalTimeoutMs: 100, recoverMs: 50 });
  try {
    const documentId = randomUUID();
    const person = peerAs(server.url, documentId, { kind: "user" });
    await until(() => person.status === "live", "live");
    state.hang = true;
    const held = person.submit(add("during"));
    await until(() => person.readOnly, "read-only after the timeout");
    state.hang = false;
    expect(held.ok && (await held.settled)).toMatchObject({ ok: true, seq: 1 });
    expect(person.readOnly).toBe(false);
    expect(rows).toHaveLength(1);
    person.close();
  } finally {
    await server.close();
  }
});
