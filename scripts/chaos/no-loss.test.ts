import { describe, expect, it } from "vitest";
import { createLedger, noLossViolations, type JournalRow, type LedgerEntry } from "./no-loss.ts";

// A ledger that saw one op acknowledged before the fault and one caught in flight, both journaled once.
const acked: LedgerEntry = { peer: "person", opId: "a", atFault: { ok: true, seq: 1 }, outcome: { ok: true, seq: 1 } };
const inFlight: LedgerEntry = { peer: "ai", opId: "b", atFault: "unsettled", outcome: { ok: true, seq: 2 } };
const first: JournalRow = { seq: 1, opId: "a" };
const journal: JournalRow[] = [first, { seq: 2, opId: "b" }];
const same = ['{"nodes":{}}', '{"nodes":{}}'];

describe("noLossViolations", () => {
  it("passes a clean run", () => {
    expect(noLossViolations({ ledger: [acked, inFlight], journal, docs: same })).toEqual([]);
  });

  it("reports an acknowledged op missing from the journal (lost)", () => {
    expect(noLossViolations({ ledger: [acked, inFlight], journal: [{ seq: 1, opId: "x" }, { seq: 2, opId: "b" }], docs: same })).toEqual([
      "journal seq 1 holds op x, which no tracked peer submitted",
      "person op a (acknowledged before the fault) was acknowledged at seq 1, but the journal has x there",
    ]);
  });

  it("reports an op journaled twice", () => {
    const violations = noLossViolations({ ledger: [acked, inFlight], journal: [...journal, { seq: 3, opId: "b" }], docs: same });
    expect(violations).toEqual(["op b is journaled 2 times (seq 2, 3)"]);
  });

  it("reports a seq gap and a duplicate seq", () => {
    expect(noLossViolations({ ledger: [acked, inFlight], journal: [{ seq: 1, opId: "a" }, { seq: 3, opId: "b" }], docs: same })).toContain("the journal's seqs are 1,3, not 1..2 without a gap or repeat");
    expect(noLossViolations({ ledger: [acked, inFlight], journal: [{ seq: 1, opId: "a" }, { seq: 1, opId: "b" }], docs: same })).toContain("the journal's seqs are 1,1, not 1..2 without a gap or repeat");
  });

  it("reports an unacknowledged op that never settled, or was refused", () => {
    expect(noLossViolations({ ledger: [acked, { ...inFlight, outcome: "unsettled" }], journal: [first], docs: same })).toEqual([
      "ai op b (in flight at the fault) never settled: lost",
    ]);
    expect(noLossViolations({ ledger: [acked, { ...inFlight, outcome: { ok: false, reason: "connection_closed" } }], journal: [first], docs: same })).toEqual([
      "ai op b (in flight at the fault) was refused (connection_closed): lost",
    ]);
  });

  it("reports an op refused before the fault that is in the journal anyway", () => {
    const refused: LedgerEntry = { peer: "person", opId: "c", atFault: { ok: false, reason: "invalid_op" }, outcome: { ok: false, reason: "invalid_op" } };
    expect(noLossViolations({ ledger: [acked, inFlight, refused], journal: [...journal, { seq: 3, opId: "c" }], docs: same })).toEqual([
      "person op c was refused (invalid_op) but is journaled",
    ]);
  });

  it("reports peers that do not converge", () => {
    expect(noLossViolations({ ledger: [acked, inFlight], journal, docs: ['{"nodes":{}}', '{"nodes":{"n":1}}'] })).toEqual(["peer 1's confirmed document differs from peer 0's"]);
  });

  it("refuses a run that proved nothing (vacuity guards)", () => {
    expect(noLossViolations({ ledger: [acked], journal: [first], docs: same })).toEqual(["vacuous: no op was in flight at the fault, so nothing was resent"]);
    expect(noLossViolations({ ledger: [{ ...inFlight, outcome: { ok: true, seq: 1 } }], journal: [{ seq: 1, opId: "b" }], docs: same })).toEqual(["vacuous: no op was acknowledged before the fault"]);
  });
});

describe("createLedger", () => {
  it("records what was settled at the fault and what settled after", async () => {
    const ledger = createLedger();
    let finish: (outcome: { ok: true; seq: number }) => void = () => undefined;
    ledger.track("person", { ok: true, opId: "a", settled: Promise.resolve({ ok: true, seq: 1 }) });
    ledger.track("ai", { ok: true, opId: "b", settled: new Promise((resolve) => { finish = resolve; }) });
    ledger.track("ai", { ok: false }); // refused locally: never sent, nothing to account for
    await Promise.resolve();
    ledger.fault();
    finish({ ok: true, seq: 2 });
    await ledger.settle(1000);
    expect(ledger.entries).toEqual([acked, inFlight]);
  });

  it("leaves an op unsettled when the wait runs out", async () => {
    const ledger = createLedger();
    ledger.track("ai", { ok: true, opId: "b", settled: new Promise(() => undefined) });
    ledger.fault();
    await ledger.settle(10);
    expect(ledger.entries).toEqual([{ peer: "ai", opId: "b", atFault: "unsettled", outcome: "unsettled" }]);
  });
});
