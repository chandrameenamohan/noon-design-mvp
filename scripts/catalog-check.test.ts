import { expect, test } from "vitest";
import { catalogProblems, readScratchbook } from "./catalog-check.ts";

// check:catalog-complete (Z.2a, SPEC §4a A0): every property in antithesis/scratchbook/ has a type, a priority, an
// assertion site and, when it is an always, the sometimes that proves its path ran.

const complete = `---
id: op-applied-at-most-once
a0: 3
observable: no sender's op is journaled twice
type: always
priority: P0
site: apps/sync/src/room.ts:346
guard: Sometimes("the room answered a resend with its original row")
guard_site: harness:parallel_driver_resend
evidence: scripts/chaos/no-loss.ts
---
body
`;
const lines = new Map([["apps/sync/src/room.ts", 428], ["scripts/chaos/no-loss.ts", 75]]);
const check = (files: Record<string, string>, catalog = "op-applied-at-most-once", a0 = [3]) =>
  catalogProblems({ files: new Map(Object.entries(files)), catalog, lineCount: (path) => lines.get(path), a0 });

test("a complete always, listed in the catalog, passes", () => {
  expect(check({ "op-applied-at-most-once.md": complete })).toEqual([]);
});

test("an always with no type, no priority, no site and no guard is named for each", () => {
  const incomplete = complete.replace(/^(type|priority|site|guard|guard_site): .*\n/gm, "");
  expect(check({ "op-applied-at-most-once.md": incomplete })).toEqual([
    "op-applied-at-most-once: type is missing (always, sometimes, unreachable, reachability or eventually)",
    "op-applied-at-most-once: priority is missing (P0, P1 or P2)",
    "op-applied-at-most-once: site is missing (path:line in the repo, or harness:<test command>)",
  ]);
  // Typed always again, it still has no vacuity guard.
  expect(check({ "op-applied-at-most-once.md": incomplete.replace("---\nid", "---\ntype: always\npriority: P1\nsite: harness:finally_ledger\nid") })).toEqual([
    "op-applied-at-most-once: an always needs a guard (the sometimes that proves its path ran)",
    "op-applied-at-most-once: guard_site is missing (path:line in the repo, or harness:<test command>)",
  ]);
});

test("a site must point at a real line or a test-template command; evidence must exist", () => {
  const moved = complete.replace("room.ts:346", "room.ts:900").replace("harness:parallel_driver_resend", "harness:resend").replace("scripts/chaos/no-loss.ts", "scripts/chaos/gone.ts");
  expect(check({ "op-applied-at-most-once.md": moved })).toEqual([
    "op-applied-at-most-once: site apps/sync/src/room.ts:900 is past the end of the file (428 lines)",
    "op-applied-at-most-once: guard_site harness:resend is not a test-template command (first_, parallel_driver_, singleton_driver_, serial_driver_, anytime_, eventually_, finally_)",
    "op-applied-at-most-once: evidence scripts/chaos/gone.ts does not exist",
  ]);
});

test("a sometimes needs no guard; a bad type or priority, an unlisted id and a missing A0 invariant are named", () => {
  const sometimes = complete.replace("type: always", "type: sometimes").replace(/^guard.*\n/gm, "").replace("a0: 3\n", "");
  expect(check({ "op-applied-at-most-once.md": sometimes }, "op-applied-at-most-once", [])).toEqual([]);
  expect(check({ "op-applied-at-most-once.md": complete.replace("type: always", "type: usually").replace("P0", "high") }, "", [3, 4])).toEqual([
    "op-applied-at-most-once: type usually is not always, sometimes, unreachable, reachability or eventually",
    "op-applied-at-most-once: priority high is not P0, P1 or P2",
    "op-applied-at-most-once: not listed in property-catalog.md",
    "A0 invariant 4 has no property",
  ]);
  expect(check({ "x.md": complete }, "op-applied-at-most-once", [])).toEqual(["x.md: id op-applied-at-most-once does not match its file name"]);
});

test("the real scratchbook is complete", () => {
  const book = readScratchbook();
  expect(book.files.size).toBeGreaterThan(0);
  expect(catalogProblems(book)).toEqual([]);
});
