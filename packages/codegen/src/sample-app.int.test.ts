import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOp, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { generate } from "./index.ts";

// F13: what the canvas generates must compile against the customer's own design system. The sample
// app is that customer repo, outside this workspace, so it is proven the way its own CI would.
const run = promisify(execFile);
const APP = new URL("../../../seed/sample-app/", import.meta.url).pathname;
const pnpm = (...args: string[]) => run("pnpm", ["--ignore-workspace", ...args], { cwd: APP, timeout: 170_000 });
// Generated pages live beside Showcase.tsx so the import path in the file is the real one. The name
// ends in .tmp.tsx, which seed/sample-app/.gitignore holds, so a crashed run cannot leave a commit behind.
const GENERATED = `${APP}src/pages/Generated.tmp.tsx`;

const add = (nodeId: string, parentId: string, component: string, props: Record<string, string | number | boolean> = {}, index = 0): Op => ({ type: "add_node", nodeId, parentId, index, component, props });

/** Every component in the design system at least once, each prop kind at least once. */
const doc: Doc = [
  add("row", ROOT_ID, "Stack", { direction: "row", gap: 16, align: "start" }),
  add("card", "row", "Card", { title: "Order", padding: 24 }),
  add("column", "card", "Stack", { gap: 8 }),
  add("text", "column", "Text", { value: 'two "items" \\ <b>', size: "lg", weight: "bold", tone: "muted" }),
  add("image", "column", "Image", { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", alt: "", width: 120, height: 80 }, 1),
  add("input", "column", "Input", { label: "Card number", placeholder: "4242", type: "number", disabled: false }, 2),
  add("button", "column", "Button", { label: "Pay $42", variant: "ghost", disabled: true }, 3),
].reduce(applyOp, emptyDoc());

test("the generated page type-checks inside the sample app, against the real design system", async () => {
  const result = generate(doc, manifest);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  // Proves the file is what the test claims before tsc ever sees it: a generator that emitted an
  // empty component would type-check happily.
  expect(result.tsx.match(/data-node-id=/gu) ?? []).toHaveLength(8);
  for (const component of ["Button", "Card", "Image", "Input", "Stack", "Text"]) expect(result.tsx).toContain(`<${component} data-node-id=`);

  await pnpm("install", "--frozen-lockfile");
  writeFileSync(GENERATED, result.tsx);
  try {
    await pnpm("exec", "tsc", "--noEmit");
  } finally {
    rmSync(GENERATED, { force: true });
  }
}, 180_000);

test("a page that names a prop the design system does not have fails to type-check", async () => {
  // The mutation check for the test above: if tsc were not really running, or were running over a
  // different file, this would pass too.
  await pnpm("install", "--frozen-lockfile");
  writeFileSync(GENERATED, `import { Text } from "../design-system/index.ts";\n\nexport function Page() {\n  return <Text data-node-id="x" value={"hi"} tone={"invented"} />;\n}\n`);
  try {
    // tsc writes its complaint to stdout and exits non-zero; execFile puts both on the error.
    const failure = await pnpm("exec", "tsc", "--noEmit").then(() => undefined, (error: unknown) => error as { stdout?: string });
    expect(failure?.stdout ?? "").toMatch(/Generated\.tmp\.tsx.*error TS/su);
  } finally {
    rmSync(GENERATED, { force: true });
  }
}, 180_000);
