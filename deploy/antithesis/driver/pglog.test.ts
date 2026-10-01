import { describe, expect, it } from "vitest";
import { landed, staleAppends, statements } from "./pglog.ts";

const DOC = "0d0c0000-0000-4000-8000-000000000001";
const [OLD, NEW] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const at = (seconds: number): string => `2026-10-01 05:00:${seconds.toFixed(3).padStart(6, "0")} UTC`;
const claim = (seconds: number, token: number, id: string, pid = 70): string[] => [
  `${at(seconds)} [${String(pid)}] LOG:  execute <unnamed>: update documents set fence_token = $3, fence_claim = $4 where org_id = $1 and id = $2 and fence_token < $3`,
  `${at(seconds)} [${String(pid)}] DETAIL:  Parameters: $1 = 'org', $2 = '${DOC}', $3 = '${String(token)}', $4 = '${id}'`,
];
const append = (seconds: number, seq: number, opId: string, id: string, pid = 71): string[] => [
  `${at(seconds)} [${String(pid)}] LOG:  execute <unnamed>: insert into op_journal (document_id, org_id, seq, op_id, actor_kind, actor_id, run_id, op) select id, org_id, $3, $4, $5, $6, $7, $8 from documents where org_id = $1 and id = $2 and fence_claim is not distinct from $9 for update`,
  `${at(seconds)} [${String(pid)}] DETAIL:  Parameters: $1 = 'org', $2 = '${DOC}', $3 = '${String(seq)}', $4 = '${opId}', $5 = 'user', $6 = 'u1', $7 = NULL, $8 = '{"type":"set_prop","nodeId":"it''s","key":"gap","value":4}', $9 = '${id}'`,
];
const log = (...blocks: string[][]): string => blocks.flat().join("\n");

describe("statements", () => {
  it("reads claims and appends with their parameters, and nothing else", () => {
    const text = log(claim(1, 3, OLD), append(2, 7, "op-a", OLD), [`${at(3)} [72] LOG:  execute <unnamed>: update jobs set heartbeat_at = now() where org_id = $1`, `${at(3)} [72] DETAIL:  Parameters: $1 = 'org'`, "noise"]);
    expect(statements(text)).toEqual([
      { kind: "claim", at: Date.parse("2026-10-01T05:00:01.000Z"), document: DOC, token: 3, claim: OLD },
      { kind: "append", at: Date.parse("2026-10-01T05:00:02.000Z"), document: DOC, seq: 7, opId: "op-a", claim: OLD },
    ]);
  });

  it("pairs a DETAIL line with the statement of its own backend, when two backends interleave", () => {
    const [claimLog = "", claimDetail = ""] = claim(1, 3, OLD, 70);
    const [appendLog = "", appendDetail = ""] = append(1, 7, "op-a", OLD, 71);
    expect(statements([claimLog, appendLog, appendDetail, claimDetail].join("\n")).map((s) => s.kind)).toEqual(["append", "claim"]);
  });
});

describe("staleAppends", () => {
  it("finds the append a zombie made under its old claim after a newer owner claimed the document", () => {
    const all = statements(log(claim(1, 1, OLD), append(2, 1, "op-a", OLD), claim(10, 2, NEW), append(11, 2, "op-b", NEW), append(20, 2, "op-c", OLD)));
    expect(staleAppends(all).map((s) => s.opId)).toEqual(["op-c"]);
  });

  it("does not take a claim under a token that is not larger for a change of owner", () => {
    const all = statements(log(claim(1, 2, OLD), claim(5, 2, NEW), append(9, 1, "op-a", OLD)));
    expect(staleAppends(all)).toEqual([]);
  });

  it("leaves out an append that started within the margin of the claim that replaced its own", () => {
    const all = statements(log(claim(1, 1, OLD), claim(10, 2, NEW), append(10.1, 1, "op-a", OLD)));
    expect(staleAppends(all)).toEqual([]);
    expect(staleAppends(all, 50).map((s) => s.opId)).toEqual(["op-a"]);
  });
});

describe("landed", () => {
  const all = statements(log(claim(1, 1, OLD), claim(10, 2, NEW), append(11, 1, "op-a", NEW), append(20, 1, "op-a", OLD), append(21, 2, "op-z", OLD)));

  it("is empty when the zombie's rows are not in the journal, or are there by the new owner's own append", () => {
    expect(landed(all, (row) => row.opId === "op-a")).toEqual([]);
  });

  it("names a zombie's append whose row is in the journal and that no rightful append explains", () => {
    expect(landed(all, () => true).map((s) => s.opId)).toEqual(["op-z"]);
  });
});
