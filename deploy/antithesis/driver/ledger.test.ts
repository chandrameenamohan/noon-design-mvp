import { describe, expect, it } from "vitest";
import type { Op } from "@noon/contracts";
import { emptyDoc } from "@noon/doc-model";
import type { LedgerEntry } from "../../../scripts/chaos/no-loss.ts";
import { answeredFromJournal, canonical, concurrent, hashOf, inFlightAtFault, lossViolations, replay, type JournalRow, type LedgerFile } from "./ledger.ts";

const add = (nodeId: string, parentId = "root"): Op => ({ type: "add_node", nodeId, parentId, index: 0, component: "Stack", props: {} });
const gap = (nodeId: string, value: number): Op => ({ type: "set_prop", nodeId, key: "gap", value });
const row = (seq: number, opId: string, op: Op, more: Partial<JournalRow> = {}): JournalRow => ({ seq, opId, actorKind: "user", actorId: "u1", runId: null, op, createdAt: 1000 + seq, ...more });
const acked = (peer: string, opId: string, seq: number, atFault: LedgerEntry["atFault"] = { ok: true, seq }): LedgerEntry => ({ peer, opId, atFault, outcome: { ok: true, seq } });
const file = (entries: LedgerEntry[], more: Partial<LedgerFile> = {}): LedgerFile => ({ document: "d", scene: "test", entries, notes: {}, epochs: {}, finals: [], viewers: [], facts: {}, ...more });

describe("canonical", () => {
  it("gives two documents built in different orders the same hash", () => {
    const [a, b] = [emptyDoc(), emptyDoc()];
    a.nodes = { ...a.nodes, x: { id: "x", component: "Stack", props: { gap: 1, align: "end" }, parentId: "root", children: [] } };
    b.nodes = { x: { id: "x", parentId: "root", children: [], props: { align: "end", gap: 1 }, component: "Stack" }, ...b.nodes };
    expect(hashOf(a)).toBe(hashOf(b));
    expect(canonical({ b: [2, { d: 1, c: 0 }], a: null })).toBe('{"a":null,"b":[2,{"c":0,"d":1}]}');
  });
});

describe("replay", () => {
  it("hashes the document after every seq, so a peer that stopped at any of them can be compared", () => {
    const { hashes, broken, doc } = replay([row(1, "o1", add("a")), row(2, "o2", add("b", "a"))]);
    expect(broken).toEqual([]);
    expect([...hashes.keys()]).toEqual([0, 1, 2]);
    expect(hashes.get(2)).toBe(hashOf(doc));
    expect(hashes.get(1)).not.toBe(hashes.get(2));
  });
});

describe("lossViolations", () => {
  it("finds nothing wrong with a quiet document whose every op is journaled where it was acknowledged", () => {
    expect(lossViolations([file([acked("ann", "o1", 1), acked("bob", "o2", 2)])], [row(1, "o1", add("a")), row(2, "o2", add("b"))])).toEqual([]);
  });

  it("names an acknowledged op the journal does not hold", () => {
    expect(lossViolations([file([acked("ann", "o1", 1), acked("ann", "o2", 2)])], [row(1, "o1", add("a"))])).toEqual([expect.stringContaining("was acknowledged at seq 2, but the journal has nothing there")]);
  });

  it("places an AI run's rows as the run's, and still refuses a row nobody submitted", () => {
    const journal = [row(1, "o1", add("a")), row(2, "ai", add("n"), { actorKind: "agent", runId: "r1" }), row(3, "ghost", add("g"))];
    expect(lossViolations([file([acked("ann", "o1", 1)])], journal)).toEqual([expect.stringContaining("holds op ghost, which no tracked peer submitted")]);
  });

  it("places the git peer's rows as their push's (Z.3: an engineer's push is nobody's ledger entry)", () => {
    const journal = [row(1, "o1", add("a")), row(2, "git", gap("a", 8), { actorKind: "git", runId: "c0ffee" })];
    expect(lossViolations([file([acked("ann", "o1", 1)])], journal)).toEqual([]);
  });

  it("excuses only the actors that submit through no driver peer: a row of an unknown actor kind is still unexplained", () => {
    const journal = [row(1, "o1", add("a")), row(2, "who", add("w"), { actorKind: "robot", runId: "r1" })];
    expect(lossViolations([file([acked("ann", "o1", 1)])], journal)).toEqual([expect.stringContaining("holds op who, which no tracked peer submitted")]);
  });

  it("joins the ledgers several processes kept of one document", () => {
    expect(lossViolations([file([acked("ann", "o1", 1)]), file([acked("probe", "o2", 2)], { scene: "probe" })], [row(1, "o1", add("a")), row(2, "o2", add("p"))])).toEqual([]);
  });
});

describe("inFlightAtFault", () => {
  it("counts only ops unanswered when a fault struck, and none in a ledger that met no fault", () => {
    const entries = [acked("ann", "o1", 1), acked("ann", "o2", 2, "unsettled"), acked("ann", "o3", 3, "after")];
    expect(inFlightAtFault(file(entries, { fault: "sync-killed" })).map((entry) => entry.opId)).toEqual(["o2"]);
    expect(inFlightAtFault(file(entries))).toEqual([]);
  });
});

describe("concurrent", () => {
  const journal = [row(1, "o1", add("a")), row(2, "o2", gap("a", 4), { actorId: "ann" }), row(3, "o3", gap("a", 12), { actorId: "bob" })];
  const notes = {
    o2: { op: gap("a", 4), seqAtSubmit: 1, ahead: 0, epochAtSubmit: 1, peer: "ann" },
    o3: { op: gap("a", 12), seqAtSubmit: 1, ahead: 0, epochAtSubmit: 1, peer: "bob" },
  };

  it("finds the op ordered behind one its sender had not seen, and that it touched the same node", () => {
    const ledger = file([acked("ann", "o2", 2), acked("bob", "o3", 3)], { notes });
    expect(concurrent(ledger, journal)).toEqual(["o3"]);
    expect(concurrent(ledger, journal, true)).toEqual(["o3"]);
  });

  it("does not take a peer's own queue for concurrency", () => {
    const own = { o2: notes.o2, o3: { ...notes.o3, ahead: 1, peer: "ann" } };
    expect(concurrent(file([acked("ann", "o2", 2), acked("ann", "o3", 3)], { notes: own }), journal)).toEqual([]);
  });
});

describe("answeredFromJournal", () => {
  const journal = [row(1, "o1", add("a"), { createdAt: 5000 })];
  const note = { op: add("a"), seqAtSubmit: 0, ahead: 0, epochAtSubmit: 1, epochAtSettle: 2, peer: "ann" };
  const epochs = { ann: [{ liveAt: 1000, token: 1 }, { liveAt: 9000, token: 2 }] };

  it("finds an op acknowledged over a later connection, by a room under another token, at a row journaled before that connection", () => {
    expect(answeredFromJournal(file([acked("ann", "o1", 1, "unsettled")], { notes: { o1: note }, epochs }), journal)).toEqual(["o1"]);
  });

  it("is not fooled by a resend the new room journaled itself, an answer on the first connection, or the same room", () => {
    const late = [row(1, "o1", add("a"), { createdAt: 9500 })];
    expect(answeredFromJournal(file([acked("ann", "o1", 1)], { notes: { o1: note }, epochs }), late)).toEqual([]);
    expect(answeredFromJournal(file([acked("ann", "o1", 1)], { notes: { o1: { ...note, epochAtSettle: 1 } }, epochs }), journal)).toEqual([]);
    expect(answeredFromJournal(file([acked("ann", "o1", 1)], { notes: { o1: note }, epochs: { ann: [{ liveAt: 1000, token: 1 }, { liveAt: 9000, token: 1 }] } }), journal)).toEqual([]);
  });
});
