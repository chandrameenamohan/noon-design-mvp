import { describe, expect, it } from "vitest";
import { leaseViolations, runViolations, type RunAfter } from "./rebuild.ts";

const done = (id: string, n: number): RunAfter => ({ id, status: "succeeded", attempts: 1, ops: n, opIds: n, nodes: n, seqs: n, maxSeq: n });
const steps = new Map([["a", 3], ["b", 2]]);

describe("runViolations", () => {
  it("passes runs that each ran once and journaled every step once", () => {
    expect(runViolations({ steps, runs: [done("a", 3), done("b", 2)], waitingAtWipe: 1, runningAtWipe: 1 })).toEqual([]);
  });

  it("reports a run that never ended, or a run claimed twice", () => {
    expect(runViolations({ steps, runs: [{ ...done("a", 3), status: "queued" }, { ...done("b", 2), attempts: 2 }], waitingAtWipe: 1, runningAtWipe: 1 })).toEqual([
      "run a ended queued, not succeeded",
      "run b was claimed 2 times: the wipe started it again",
    ]);
  });

  it("reports a missing run, a duplicate op or node, and a seq gap", () => {
    expect(runViolations({ steps, runs: [{ ...done("b", 2), ops: 3, seqs: 2, maxSeq: 3 }], waitingAtWipe: 1, runningAtWipe: 1 })).toEqual([
      "run a has no row",
      "run b journaled ops=3 opIds=2 nodes=2, not 2 of each",
      "run b's document has 2 distinct seqs up to 3: a gap or a repeat",
    ]);
  });

  it("says a run with nothing waiting or nothing running at the wipe proved nothing", () => {
    expect(runViolations({ steps, runs: [done("a", 3), done("b", 2)], waitingAtWipe: 0, runningAtWipe: 0 })).toEqual([
      "vacuous: no job was waiting in Redis at the wipe, so no queue had to be rebuilt",
      "vacuous: no job was running at the wipe",
    ]);
  });
});

describe("leaseViolations", () => {
  const before = { token: 4, node: "sync" };

  it("passes one new owner, above the old token, named by the fence", () => {
    expect(leaseViolations({ before, after: { token: 5, node: "sync-2" }, fenceToken: 5 })).toEqual([]);
    expect(leaseViolations({ before, after: { token: 5, node: "sync" }, fenceToken: 5 })).toEqual([]); // the same node may take it again
  });

  it("reports no owner, a reissued token, and a fence that names another owner", () => {
    expect(leaseViolations({ before, after: undefined, fenceToken: 4 })).toEqual(["nobody holds the room's lease after the wipe"]);
    expect(leaseViolations({ before, after: { token: 1, node: "sync-2" }, fenceToken: 4 })).toEqual([
      "the lease's token went from 4 to 1: a flushed counter issued a token again",
      "the journal's fence is at token 4 but the lease is 1:sync-2: two owners",
    ]);
  });
});
