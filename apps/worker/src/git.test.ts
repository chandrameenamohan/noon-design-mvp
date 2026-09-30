import { expect, test } from "vitest";
import { moved, pageDocument, parseHeads } from "./git.ts";
import { pagePath } from "./sandbox.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const id = "0f9c7a0e-1b2c-4d3e-8f00-000000000001";

test("a generated page names its document; nothing else in the repo does", () => {
  expect(pageDocument(pagePath(id))).toBe(id); // the path the sandbox writes is the path the git peer reads
  for (const path of ["src/pages/Home.tsx", `src/pages/noon-${id}.ts`, `src/pages/noon-${id}.tsx.bak`, `x/src/pages/noon-${id}.tsx`, `src/pages/sub/noon-${id}.tsx`, `src/pages/noon-${id.toUpperCase()}.tsx`, ""]) {
    expect(pageDocument(path), path).toBeUndefined();
  }
});

test("the mirror's branches are read line by line; a name the db would refuse is skipped, not recorded", () => {
  const output = [`refs/heads/main ${A}`, `refs/heads/noon/${id} ${B}`, `refs/heads/a b ${A}`, `refs/heads/x ${"Z".repeat(40)}`, `refs/tags/v1 ${A}`, ""].join("\n");
  expect(parseHeads(output)).toEqual(new Map([["refs/heads/main", A], [`refs/heads/noon/${id}`, B]]));
});

test("the reconcile records exactly the branches that moved, a new one from zeros", () => {
  const mirror = new Map([["refs/heads/main", B], ["refs/heads/same", A], ["refs/heads/new", A]]);
  const recorded = new Map([["refs/heads/main", A], ["refs/heads/same", A], ["refs/heads/gone", A]]);
  expect(moved(mirror, recorded)).toEqual([
    { ref: "refs/heads/main", before: A, after: B },
    { ref: "refs/heads/new", before: "0".repeat(40), after: A },
  ]);
  expect(moved(recorded, recorded)).toEqual([]);
});
