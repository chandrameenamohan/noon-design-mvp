import { expect, test } from "vitest";
import type { Doc, Op, PropValue } from "@noon/contracts";
import { applyOp, emptyDoc, ROOT_ID, validate } from "@noon/doc-model";
import { randomOp, seeded } from "@noon/doc-model/random-ops";
import { testManifest as manifest } from "@noon/doc-model/fixtures";
import { generate, parse } from "./index.ts";

const add = (nodeId: string, parentId: string, component = "Stack", props: Record<string, PropValue> = {}, index = 0): Op => ({ type: "add_node", nodeId, parentId, index, component, props });
const build = (...ops: Op[]): Doc => ops.reduce(applyOp, emptyDoc());

const tsx = (doc: Doc): string => {
  const result = generate(doc, manifest);
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.tsx;
};
const parsed = (file: string): Doc => {
  const result = parse(file, manifest);
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.doc;
};
const refusal = (file: string): string => {
  const result = parse(file, manifest);
  return result.ok ? "parsed" : result.reason;
};

/** A file of the generated shape around a hand-written JSX body (the root div's children). */
const page = (body: string, imports = "Alert, Button, Stack"): string =>
  `import { ${imports} } from "../design-system/index.ts";\n\nexport function Page() {\n  return (\n    <div data-node-id="root">\n${body}\n    </div>\n  );\n}\n`;

// --- unit:parse-roundtrip ------------------------------------------------------------------------

test("unit:parse-roundtrip: doc -> TSX -> doc is identity", () => {
  const doc = build(
    add("s", ROOT_ID, "Stack", { gap: 16, direction: "row" }),
    add("b", "s", "Button", { label: 'a "quoted" \\ {brace} <tag> & \n tab\t ünï 😀', disabled: false }),
    add("a", "s", "Alert", {}, 1),
    add("inner", ROOT_ID, "Stack", { gap: -3.5 }, 1),
  );
  expect(parsed(tsx(doc))).toEqual(doc);
});

test("unit:parse-roundtrip: an empty document survives the round trip", () => {
  expect(parsed(tsx(emptyDoc()))).toEqual(emptyDoc());
});

test("unit:parse-roundtrip: every document random ops can build comes back as itself", () => {
  const random = seeded(20260930);
  let doc = emptyDoc();
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const op = randomOp(random, doc);
    if (validate(doc, op, manifest).ok) doc = applyOp(doc, op);
    if (i % 20 !== 0) continue;
    expect(parsed(tsx(doc))).toEqual(doc);
    checked++;
  }
  expect(checked).toBe(200);
});

test("unit:parse-roundtrip: formatting is not shape (quotes, line breaks, comments, a self-closed empty element)", () => {
  const doc = build(add("s", ROOT_ID, "Stack", { gap: 16 }), add("b", "s", "Button", { label: "Pay", disabled: true }));
  const reformatted = `// an engineer's comment
import {Stack, Button} from '../design-system/index.ts'

/** the page */
export function Page() {
  return <div data-node-id='root'>
    {/* a comment child */}
    <Stack
      gap={0x10}
      data-node-id="s"
    >
      <Button label="Pay" disabled data-node-id="b"></Button>
    </Stack>
  </div>
}
`;
  expect(parsed(reformatted)).toEqual(doc);
});

test("unit:parse-roundtrip: an in-shape edit comes back as the edited document", () => {
  const doc = build(add("s", ROOT_ID), add("b", "s", "Button", { label: "Pay" }));
  const edited = tsx(doc).replace(`label={"Pay"}`, `label={"Pay now"} disabled={true}`);
  expect(parsed(edited).nodes["b"]?.props).toEqual({ label: "Pay now", disabled: true });
});

// --- unit:parse-shape-breakers -------------------------------------------------------------------
// Each is a file an engineer could push. None of them may become a document, and each must say why.

test.each<[string, string, string]>([
  ["a prop that reads a variable", page(`<Button data-node-id="b" label={name} />`), "non_literal_prop"],
  ["a prop that is a template literal", page("<Button data-node-id=\"b\" label={`Pay`} />"), "non_literal_prop"],
  ["a prop that is a function call", page(`<Button data-node-id="b" label={t("pay")} />`), "non_literal_prop"],
  ["a prop that is an object", page(`<Stack data-node-id="s" gap={{ a: 1 }} />`), "non_literal_prop"],
  ["a number that is not finite", page(`<Stack data-node-id="s" gap={1e999} />`), "non_literal_prop"],
  ["a bigint", page(`<Stack data-node-id="s" gap={10n} />`), "non_literal_prop"],
  ["a unary plus", page(`<Stack data-node-id="s" gap={+1} />`), "non_literal_prop"],
  ["a quoted attribute holding an HTML entity", page(`<Button data-node-id="b" label="a &amp; b" />`), "non_literal_prop"],
  ["a prop that is an element", page(`<Button data-node-id="b" label=<Alert data-node-id="a" /> />`), "non_literal_prop"],
  ["a spread attribute", page(`<Button data-node-id="b" {...props} />`), "spread"],
  ["a spread child", page(`<Stack data-node-id="s">{...items}</Stack>`), "spread"],
  ["a conditional child (&&)", page(`{open && <Alert data-node-id="a" />}`), "conditional"],
  ["a conditional child (?:)", page(`{open ? <Alert data-node-id="a" /> : null}`), "conditional"],
  ["a conditional prop", page(`<Stack data-node-id="s" gap={wide ? 16 : 8} />`), "conditional"],
  ["a .map() child", page(`{items.map((item) => <Alert data-node-id={item} />)}`), "map"],
  ["any other expression child", page(`{label}`), "expression_child"],
  ["text inside an element", page(`<Stack data-node-id="s">hello</Stack>`), "text_child"],
  ["a fragment", page(`<><Alert data-node-id="a" /></>`), "not_an_element"],
  ["a member-expression tag", page(`<UI.Alert data-node-id="a" />`), "not_an_element"],
  ["an HTML tag below the root", page(`<span data-node-id="x" />`), "unknown_component"],
  ["a tag that is not imported", page(`<Alert data-node-id="a" />`, "Button"), "bad_import"],
  ["an element without a node id", page(`<Alert />`), "missing_node_id"],
  ["a node id that is an expression", page(`<Alert data-node-id={id} />`), "bad_node_id"],
  ["a node id with a forbidden character", page(`<Alert data-node-id="a.b" />`), "bad_node_id"],
  ["a node id that is a name on Object.prototype", page(`<Alert data-node-id="constructor" />`), "bad_node_id"],
  ["a node id longer than the contract allows", page(`<Alert data-node-id="${"x".repeat(65)}" />`), "bad_node_id"],
  ["the same node id twice", page(`<Alert data-node-id="a" />\n<Alert data-node-id="a" />`), "duplicate_node_id"],
  ["the same prop twice", page(`<Stack data-node-id="s" gap={1} gap={2} />`), "duplicate_prop"],
  ["a prop named after Object.prototype", page(`<Stack data-node-id="s" __proto__={1} />`), "unknown_prop"],
  ["a namespaced prop", page(`<Stack data-node-id="s" xml:gap={1} />`), "unknown_prop"],
  ["a prop the component does not have", page(`<Stack data-node-id="s" colour={"red"} />`), "unknown_prop"],
  ["a prop of the wrong type", page(`<Stack data-node-id="s" gap={"wide"} />`), "wrong_prop_type"],
  ["a missing required prop", page(`<Button data-node-id="b" />`), "missing_required_prop"],
  ["children under a component that takes none", page(`<Button data-node-id="b" label={"x"}><Alert data-node-id="a" /></Button>`), "parent_takes_no_children"],
  ["a component the design system does not have", page(`<Carousel data-node-id="c" />`, "Carousel"), "unknown_component"],
  ["props on the root", page("").replace(`<div data-node-id="root">`, `<div data-node-id="root" gap={1}>`), "malformed_doc"],
  ["a root that is not a div", page("").replace(`<div data-node-id="root">`, `<main data-node-id="root">`).replace("</div>", "</main>"), "not_page_component"],
  ["negative zero, which the contract refuses", page(`<Stack data-node-id="s" gap={-0} />`), "malformed_doc"],
  ["a syntax error", page(`<Stack data-node-id="s">`), "syntax_error"],
])("unit:parse-shape-breakers: %s", (_name, file, reason) => {
  expect(refusal(file)).toBe(reason);
});

const shell = (before: string, body: string, after = ""): string =>
  `${before}\nexport function Page() {\n${body}\n}\n${after}`;
const ROOT = `  return <div data-node-id="root" />;`;
const IMPORT = `import { Alert } from "../design-system/index.ts";`;

test.each<[string, string, string]>([
  ["an extra top-level statement", shell(`${IMPORT}\nconst x = 1;`, ROOT), "extra_statement"],
  ["a directive", shell(`"use client";\n${IMPORT}`, ROOT), "extra_statement"],
  ["a hook in the page body", shell(IMPORT, `  const [open] = useState(false);\n${ROOT}`), "hook"],
  ["a hook called for its effect", shell(IMPORT, `  useEffect(() => {});\n${ROOT}`), "hook"],
  ["another statement in the page body", shell(IMPORT, `  console.log("hi");\n${ROOT}`), "extra_statement"],
  ["a second export", shell(IMPORT, ROOT, "export const BUILD_ID = 1;"), "second_export"],
  ["a default export", shell(IMPORT, ROOT, "export default Page;"), "second_export"],
  ["a re-export", shell(IMPORT, ROOT, `export { Alert } from "../design-system/index.ts";`), "second_export"],
  ["a second exported function", shell(IMPORT, ROOT, "export function Other() { return null; }"), "second_export"],
  ["the page as an arrow function", `${IMPORT}\nexport const Page = () => <div data-node-id="root" />;\n`, "not_page_component"],
  ["no page at all", `${IMPORT}\n`, "not_page_component"],
  ["a page that is not exported", `${IMPORT}\nfunction Page() {\n${ROOT}\n}\n`, "not_page_component"],
  ["a page with another name", `${IMPORT}\nexport function Home() {\n${ROOT}\n}\n`, "not_page_component"],
  ["a page that takes props", `${IMPORT}\nexport function Page(props: object) {\n${ROOT}\n}\n`, "not_page_component"],
  ["an async page", `${IMPORT}\nexport async function Page() {\n${ROOT}\n}\n`, "not_page_component"],
  ["a page with a return type", `${IMPORT}\nexport function Page(): unknown {\n${ROOT}\n}\n`, "not_page_component"],
  ["a page that returns something other than an element", shell(IMPORT, "  return null;"), "not_an_element"],
  ["a default import", shell(`import DS from "../design-system/index.ts";`, ROOT), "bad_import"],
  ["a namespace import", shell(`import * as DS from "../design-system/index.ts";`, ROOT), "bad_import"],
  ["an aliased import", shell(`import { Alert as Box } from "../design-system/index.ts";`, ROOT), "bad_import"],
  ["a type-only import", shell(`import type { Alert } from "../design-system/index.ts";`, ROOT), "bad_import"],
  ["a deferred import", shell(`import defer * as DS from "../design-system/index.ts";`, ROOT), "bad_import"],
  ["an import from anywhere else", shell(`import { useState } from "react";`, ROOT), "bad_import"],
  ["a side-effect import", shell(`import "./evil.ts";`, ROOT), "bad_import"],
  ["two imports", shell(`${IMPORT}\n${IMPORT}`, ROOT), "bad_import"],
  ["an import of the page's own name", shell(`import { Page } from "../design-system/index.ts";`, ROOT), "reserved_component"],
])("unit:parse-shape-breakers: %s", (_name, file, reason) => {
  expect(refusal(file)).toBe(reason);
});

test("unit:parse-shape-breakers: the reason's detail names the line", () => {
  const result = parse(page(`<Button data-node-id="b" label={name} />`), manifest);
  expect(result.ok ? "" : result.detail).toMatch(/^line 6: /u);
});

test("unit:parse-shape-breakers: a file larger than the cap is refused before it is parsed", () => {
  expect(refusal(page(`<Button data-node-id="b" label={"${"x".repeat(3 * 1024 * 1024)}"} />`))).toBe("too_large");
});

test("unit:parse-shape-breakers: more nodes than a room holds are refused", () => {
  const body = Array.from({ length: 5000 }, (_, i) => `<Alert data-node-id="a${String(i)}" />`).join("\n");
  expect(refusal(page(body))).toBe("too_large");
});

test("unit:parse-shape-breakers: a tree deeper than a room allows is refused", () => {
  const deep = (levels: number): string => `${Array.from({ length: levels }, (_, i) => `<Stack data-node-id="s${String(i)}">`).join("")}${"</Stack>".repeat(levels)}`;
  expect(refusal(page(deep(64)))).toBe("parsed"); // the root is depth 0, so 64 Stacks reach depth 64
  expect(refusal(page(deep(65)))).toBe("too_deep");
});

test("unit:parse-shape-breakers: nesting deep enough to exhaust the parser's stack is a reason, not a crash", () => {
  const levels = 250_000; // 7 bytes a level: under the size cap, so it is the parser that meets it
  expect(parse(page(`${"<a>".repeat(levels)}${"</a>".repeat(levels)}`), manifest)).toMatchObject({ ok: false, reason: "too_deep" });
});

test.each<[string, unknown]>([
  ["undefined", undefined],
  ["a number", 42],
  ["an object with a lying toString", { toString: () => page("") }],
])("unit:parse-shape-breakers: input that is not a string is a reason, not an exception: %s", (_name, input) => {
  expect(parse(input as string, manifest)).toMatchObject({ ok: false, reason: "malformed_doc" });
});
