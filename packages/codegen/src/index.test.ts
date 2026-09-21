import { expect, test } from "vitest";
import type { Doc, Manifest, Op, PropValue } from "@noon/contracts";
import { applyOp, applyOpInto, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { testManifest as manifest } from "@noon/doc-model/fixtures";
import { generate } from "./index.ts";

const add = (nodeId: string, parentId: string, component = "Stack", props: Record<string, PropValue> = {}, index = 0): Op => ({ type: "add_node", nodeId, parentId, index, component, props });
const build = (...ops: Op[]): Doc => ops.reduce(applyOp, emptyDoc());

/** The generated file, or a thrown error naming the reason: every test below wants one or the other. */
const tsx = (doc: Doc, m: Manifest = manifest): string => {
  const result = generate(doc, m);
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.tsx;
};
const refusal = (doc: Doc, m: Manifest = manifest): string => {
  const result = generate(doc, m);
  return result.ok ? "generated" : result.reason;
};

// --- the fixed shape -------------------------------------------------------------------------

test("a document becomes one file: a banner, the imports it uses, and the page component", () => {
  const doc = build(add("s", ROOT_ID), add("b", "s", "Button", { label: "Pay" }));
  expect(tsx(doc)).toBe(
    `// Generated from the document by @noon/codegen. Do not edit: the sandbox overwrites it.

import { Button, Stack } from "../design-system/index.ts";

export function Page() {
  return (
    <div data-node-id="root">
      <Stack data-node-id="s">
        <Button data-node-id="b" label={"Pay"} />
      </Stack>
    </div>
  );
}
`,
  );
});

test("an empty document still generates the page component, with no import line", () => {
  expect(tsx(emptyDoc())).toBe(
    `// Generated from the document by @noon/codegen. Do not edit: the sandbox overwrites it.

export function Page() {
  return (
    <div data-node-id="root" />
  );
}
`,
  );
});

test("the file exports the page component and nothing else", () => {
  const doc = build(add("s", ROOT_ID), add("b", "s", "Button", { label: "Pay" }));
  // Fast Refresh keeps React state only while the module exports components alone: one extra
  // export (a BUILD_ID, say) turns every edit into a full page reload (learning-tests/sandbox).
  const exports = tsx(doc).match(/^export\b.*$/gmu) ?? [];
  expect(exports).toEqual(["export function Page() {"]);
});

test("every element carries its node id", () => {
  const doc = build(add("s", ROOT_ID), add("b", "s", "Button", { label: "Pay" }), add("inner", "s", "Stack", {}, 1));
  const file = tsx(doc);
  const openingTags = file.match(/<[A-Za-z]/gu) ?? [];
  const ids = file.match(/data-node-id="/gu) ?? [];
  expect(openingTags).toHaveLength(4); // div(root) + Stack + Button + Stack
  expect(ids).toHaveLength(openingTags.length);
  expect(file).toContain(`<div data-node-id="root">`);
  expect(file).toContain(`<Button data-node-id="b" label={"Pay"} />`);
});

test("only the components the document actually uses are imported", () => {
  const doc = build(add("b", ROOT_ID, "Button", { label: "Pay" }));
  expect(tsx(doc)).toContain(`import { Button } from "../design-system/index.ts";`);
  expect(tsx(doc)).not.toContain("Stack");
});

test("the import line is in name order, not the order the tree happens to reach the components", () => {
  const stackFirst = build(add("s", ROOT_ID), add("b", "s", "Button", { label: "Pay" }), add("a", "s", "Alert", {}, 1));
  const alertFirst = build(add("a", ROOT_ID, "Alert"), add("s", ROOT_ID, "Stack", {}, 1), add("b", "s", "Button", { label: "Pay" }));
  const line = `import { Alert, Button, Stack } from "../design-system/index.ts";`;
  expect(tsx(stackFirst)).toContain(line);
  expect(tsx(alertFirst)).toContain(line);
});

// --- values ----------------------------------------------------------------------------------

test("each prop kind is written as a JSX expression, so no text ever needs HTML escaping", () => {
  const doc = build(add("s", ROOT_ID, "Stack", { gap: 16, direction: "row" }), add("b", "s", "Button", { label: 'a "quoted" \\ {brace} <tag>', disabled: true }));
  const file = tsx(doc);
  expect(file).toContain(`<Stack data-node-id="s" direction={"row"} gap={16}>`);
  expect(file).toContain(`<Button data-node-id="b" disabled={true} label={"a \\"quoted\\" \\\\ {brace} <tag>"} />`);
});

test("props are written in name order, whatever order they were set in", () => {
  const forwards = build(add("s", ROOT_ID), { type: "set_prop", nodeId: "s", key: "gap", value: 4 }, { type: "set_prop", nodeId: "s", key: "direction", value: "row" });
  const backwards = build(add("s", ROOT_ID), { type: "set_prop", nodeId: "s", key: "direction", value: "row" }, { type: "set_prop", nodeId: "s", key: "gap", value: 4 });
  expect(Object.keys(forwards.nodes["s"]?.props ?? {})).not.toEqual(Object.keys(backwards.nodes["s"]?.props ?? {}));
  expect(tsx(forwards)).toBe(tsx(backwards));
  expect(tsx(forwards)).toContain(`<Stack data-node-id="s" direction={"row"} gap={4} />`);
});

test("a prop set back to its default is written out, because absent and default are different documents", () => {
  const doc = build(add("s", ROOT_ID, "Stack", { gap: 8 }));
  expect(tsx(doc)).toContain("gap={8}");
});

// --- determinism ------------------------------------------------------------------------------

test("the same document always generates byte-identical TSX", () => {
  const doc = build(add("s", ROOT_ID, "Stack", { gap: 16 }), add("b", "s", "Button", { label: "Pay" }));
  expect(tsx(doc)).toBe(tsx(doc));
});

test("two documents built by different op orders that end in the same state generate the same bytes", () => {
  const oneWay = build(
    add("a", ROOT_ID, "Stack", { gap: 1 }),
    add("b", ROOT_ID, "Stack", { gap: 2 }, 1),
    add("x", "a", "Button", { label: "x" }),
    add("y", "b", "Button", { label: "y" }),
  );
  const otherWay = build(
    add("b", ROOT_ID, "Stack", {}),
    add("y", "b", "Button", { label: "y" }),
    add("a", ROOT_ID, "Stack", {}, 0),
    add("x", "a", "Button", { label: "x" }),
    { type: "set_prop", nodeId: "b", key: "gap", value: 2 },
    { type: "set_prop", nodeId: "a", key: "gap", value: 1 },
  );
  // The two documents hold the same tree stored in a different key order: that is the whole point.
  expect(Object.keys(oneWay.nodes)).not.toEqual(Object.keys(otherWay.nodes));
  expect(tsx(oneWay)).toBe(tsx(otherWay));
});

test("generation walks the tree from the root and never the key order of doc.nodes", () => {
  const doc = build(add("a", ROOT_ID), add("b", ROOT_ID, "Stack", {}, 1));
  // Same tree, nodes re-keyed in the opposite order. A generator that iterated doc.nodes would flip.
  const reversed: Doc = { rootId: doc.rootId, nodes: Object.fromEntries(Object.entries(doc.nodes).reverse()) };
  expect(Object.keys(reversed.nodes)).not.toEqual(Object.keys(doc.nodes));
  expect(tsx(reversed)).toBe(tsx(doc));
  expect(tsx(doc).indexOf(`"a"`)).toBeLessThan(tsx(doc).indexOf(`"b"`));
});

test("a tree deeper than any call stack is generated by iterating, not by recursing", () => {
  const doc = emptyDoc();
  let parent = ROOT_ID;
  for (let i = 0; i < 20_000; i++) {
    const id = `n${String(i)}`;
    applyOpInto(doc, add(id, parent));
    parent = id;
  }
  expect(tsx(doc).match(/data-node-id=/gu) ?? []).toHaveLength(20_001);
});

// --- drift: the design system changed under a document that already exists ---------------------

test.each<[string, Doc, string]>([
  ["a component the design system no longer has", build(add("s", ROOT_ID), add("gone", "s", "Carousel")), "unknown_component"],
  ["a prop the component no longer has", withProps("s", { colour: "red" }), "unknown_prop"],
  ["a prop whose type changed", withProps("s", { gap: "wide" }), "wrong_prop_type"],
  ["an enum value that is no longer an option", withProps("s", { direction: "diagonal" }), "wrong_prop_type"],
  ["a required prop the node never had", build(add("b", ROOT_ID, "Button", {})), "missing_required_prop"],
  ["children under a component that takes none", childrenUnder("Button"), "parent_takes_no_children"],
  ["a root that is not the reserved page component", rootNode({ component: "Stack" }), "malformed_doc"],
  ["props on the root", rootNode({ props: { gap: 1 } }), "malformed_doc"],
  ["a child id that is not in the document", rootNode({ children: ["ghost"] }), "malformed_doc"],
  ["a node reachable twice", sharedChild(), "malformed_doc"],
  ["a node id that could close the attribute it sits in", hostileNodeId(), "malformed_doc"],
])("refuses to generate: %s", (_name, doc, reason) => {
  expect(refusal(doc)).toBe(reason);
});

test("a manifest whose prop name is not an identifier cannot reach the generated file", () => {
  const hostile: Manifest = { version: 1, components: [{ name: "Stack", acceptsChildren: true, props: [{ name: 'gap"; onLoad="steal()', type: { kind: "number" }, required: false }] }] };
  expect(refusal(withProps("s", { 'gap"; onLoad="steal()': 1 }), hostile)).toBe("malformed_doc");
});

test("a manifest whose component name is not an identifier cannot reach the generated file", () => {
  const hostile: Manifest = { version: 1, components: [{ name: "Stack/*", acceptsChildren: true, props: [] }] };
  const doc: Doc = { rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null, children: ["s"] }, s: { id: "s", component: "Stack/*", props: {}, parentId: "root", children: [] } } };
  expect(refusal(doc, hostile)).toBe("malformed_doc");
});

test("a document that is valid against the manifest is always generated", () => {
  const doc = build(add("s", ROOT_ID, "Stack", { gap: 16, direction: "row" }), add("b", "s", "Button", { label: "Pay", disabled: false }));
  expect(generate(doc, manifest).ok).toBe(true);
});

// --- fixtures that deliberately break a rule ---------------------------------------------------

/** One Stack under the root whose props are written straight in, bypassing the ops that would refuse them. */
function withProps(nodeId: string, props: Record<string, PropValue>): Doc {
  return {
    rootId: "root",
    nodes: {
      root: { id: "root", component: "Page", props: {}, parentId: null, children: [nodeId] },
      [nodeId]: { id: nodeId, component: "Stack", props, parentId: "root", children: [] },
    },
  };
}

/** A document that is nothing but a root, with one of the root's own fields replaced. */
function rootNode(override: Partial<Doc["nodes"][string]>): Doc {
  return { rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null, children: [], ...override } } };
}

/** A node parked under a component whose manifest entry says it takes no children. */
function childrenUnder(component: string): Doc {
  return {
    rootId: "root",
    nodes: {
      root: { id: "root", component: "Page", props: {}, parentId: null, children: ["p"] },
      p: { id: "p", component, props: { label: "Pay" }, parentId: "root", children: ["c"] },
      c: { id: "c", component: "Stack", props: {}, parentId: "p", children: [] },
    },
  };
}

/** One node listed as the child of two parents: a shape no op can produce and checkDoc refuses. */
function sharedChild(): Doc {
  return {
    rootId: "root",
    nodes: {
      root: { id: "root", component: "Page", props: {}, parentId: null, children: ["a", "b"] },
      a: { id: "a", component: "Stack", props: {}, parentId: "root", children: ["c"] },
      b: { id: "b", component: "Stack", props: {}, parentId: "root", children: ["c"] },
      c: { id: "c", component: "Stack", props: {}, parentId: "a", children: [] },
    },
  };
}

/** The contract refuses this id; a snapshot written before that rule would not. It must not become code. */
function hostileNodeId(): Doc {
  const id = 'x" onLoad="steal()';
  return {
    rootId: "root",
    nodes: {
      root: { id: "root", component: "Page", props: {}, parentId: null, children: [id] },
      [id]: { id, component: "Stack", props: {}, parentId: "root", children: [] },
    },
  };
}
