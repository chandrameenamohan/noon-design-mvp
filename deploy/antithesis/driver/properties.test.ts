import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimMessage, guardMessage, guardsMissed, judge, notPassing, parseSdkOutput, PROPERTIES, table, windowMessage, WINDOWS, type AssertRecord, type Window } from "./properties.ts";

const CATALOG = new URL("../../../antithesis/scratchbook/properties/", import.meta.url);
/** The flat `key: value` front matter of one evidence file. */
function frontMatter(file: string): Map<string, string> {
  const [, block = ""] = readFileSync(new URL(file, CATALOG), "utf8").split("---\n");
  return new Map(block.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
}

const pass = (message: string): AssertRecord => ({ message, hit: true, condition: true });
const fail = (message: string): AssertRecord => ({ message, hit: true, condition: false });
/** Every property held and every guard fired: the baseline the acceptance asks for. */
const allGreen = (): AssertRecord[] => [
  ...PROPERTIES.filter((p) => p.kind !== "unreachable" && p.kind !== "reachability").map((p) => pass(claimMessage(p.slug))),
  ...PROPERTIES.filter((p) => p.guard !== undefined).map((p) => pass(guardMessage(p.slug))),
  ...(Object.keys(WINDOWS) as Window[]).map((window) => pass(windowMessage(window))),
];
const rowOf = (records: AssertRecord[], slug: string) => judge(records).find((row) => row.slug === slug);

describe("the harness's property list", () => {
  it("is the catalog: the same 23 slugs, each with the catalog's type, priority and guard", () => {
    const files = readdirSync(CATALOG).filter((name) => name.endsWith(".md"));
    expect(PROPERTIES.map((p) => p.slug).sort()).toEqual(files.map((name) => name.replace(/\.md$/, "")).sort());
    for (const property of PROPERTIES) {
      const front = frontMatter(`${property.slug}.md`);
      expect([property.slug, property.kind, property.priority]).toEqual([property.slug, front.get("type"), front.get("priority")]);
      const guard = /^Sometimes\("(.*)"\)$/.exec(front.get("guard") ?? "")?.[1];
      expect([property.slug, property.guard]).toEqual([property.slug, guard]);
    }
  });

  it("gives every always, unreachable and eventually property a guard", () => {
    for (const property of PROPERTIES) if (["always", "unreachable", "eventually"].includes(property.kind)) expect(property.guard, property.slug).toBeDefined();
  });
});

describe("judge", () => {
  it("passes a run in which every property held and every guard fired", () => {
    const rows = judge(allGreen());
    expect(notPassing(rows)).toEqual([]);
    expect(guardsMissed(rows)).toEqual([]);
    expect(table(rows)).toContain("23/23 properties PASS, 21/21 vacuity guards hit");
  });

  it("does not pass an always that was never evaluated", () => {
    const rows = judge(allGreen().filter((record) => record.message !== claimMessage("peers-converge")));
    expect(notPassing(rows)).toEqual(["peers-converge: NOT RUN"]);
  });

  it("fails an always on one false among many trues", () => {
    expect(rowOf([...allGreen(), fail(claimMessage("journal-seq-contiguous"))], "journal-seq-contiguous")).toMatchObject({ verdict: "FAIL", passes: 1, fails: 1 });
  });

  it("fails an unreachable on one hit, and passes it on none", () => {
    expect(rowOf(allGreen(), "no-cross-org-read")?.verdict).toBe("PASS");
    expect(rowOf([...allGreen(), fail(claimMessage("no-cross-org-read"))], "no-cross-org-read")?.verdict).toBe("FAIL");
  });

  it("fails the reachability property and names the windows the run never entered", () => {
    const row = rowOf(allGreen().filter((record) => record.message !== windowMessage("R7")), "dangerous-windows-reached");
    expect(row).toMatchObject({ verdict: "FAIL", note: "not reached: R7" });
  });

  it("reports a guard that only ever evaluated false as missed", () => {
    const records = [...allGreen().filter((record) => record.message !== guardMessage("peers-converge")), fail(guardMessage("peers-converge"))];
    expect(guardsMissed(judge(records))).toEqual(["peers-converge: its guard never fired"]);
  });

  it("needs a sometimes to be true once", () => {
    const without = allGreen().filter((record) => record.message !== claimMessage("ai-and-person-edit-together"));
    expect(rowOf([...without, fail(claimMessage("ai-and-person-edit-together"))], "ai-and-person-edit-together")?.verdict).toBe("FAIL");
  });
});

describe("parseSdkOutput", () => {
  it("reads the SDK's JSON lines and skips what is not an assertion or not whole", () => {
    const text = [
      JSON.stringify({ antithesis_assert: { id: "a", message: "m", hit: true, condition: false, assert_type: "always" } }),
      JSON.stringify({ antithesis_setup: { status: "complete" } }),
      '{"antithesis_assert": {"message": "cut off',
      "",
    ].join("\n");
    expect(parseSdkOutput(text)).toEqual([{ message: "m", hit: true, condition: false }]);
  });

  it("does not count a registration (hit: false) as an evaluation", () => {
    expect(rowOf([{ message: claimMessage("peers-converge"), hit: false, condition: false }], "peers-converge")?.verdict).toBe("NOT RUN");
  });
});
