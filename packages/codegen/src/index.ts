import type { Doc, Manifest } from "@noon/contracts";
import { checkDoc, checkProp, nodeOf, type PropProblem } from "@noon/doc-model";

/**
 * Keystone 8: one document becomes ONE generated TSX file of a fixed shape, and the same document
 * always generates the same bytes. Determinism is not tidiness here: epic 5 opens a pull request
 * whose file must equal a fresh generation, and epic 4's sandbox pushes this file into a running
 * container. A generator that sorted differently on two machines would show a diff nobody made.
 *
 * So: the tree is walked from `rootId` (never the key order of `doc.nodes`), props are written in
 * name order, and nothing here reads the clock, the random number generator or the environment.
 *
 * Generate from `peer.confirmed`, never from the optimistic document: the optimistic tree holds ops
 * the server has not accepted and may still refuse.
 */

const BANNER = "// Generated from the document by @noon/codegen. Do not edit: the sandbox overwrites it.";
const DESIGN_SYSTEM = "../design-system/index.ts";
/**
 * The root node is the page itself: it is never placed, moved, removed or given props (doc-model).
 * The name is RESERVED for everyone else too, because the generated file declares `export function
 * Page()`: a design system that exported its own `Page` would put an import of that name beside the
 * declaration, which is TS2440. `validate()` refuses to place one; this refuses to generate one.
 */
const ROOT_COMPONENT = "Page";
const INDENT = "  ";
// ponytail: indentation stops stepping right at the room's own depth cap (64), so a pathological
// document costs O(nodes) bytes instead of O(nodes²). Drop the cap if a deeper tree is ever read.
const MAX_INDENT_DEPTH = 66;

/**
 * Both names become CODE: a component name becomes a JSX tag, a prop name becomes an attribute.
 * They arrive from the manifest, which is generated from someone else's TypeScript, so "it can only
 * be an identifier" is an assumption, not a fact. Anything else is refused rather than emitted.
 */
const isIdentifier = (name: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
/** A node id is written inside a double-quoted attribute. The contract allows only these characters; a document loaded from a snapshot may not have met that contract. */
const isNodeId = (id: string): boolean => /^[A-Za-z0-9_-]+$/u.test(id);

// ponytail: not exported until a caller needs to switch on it; Generated carries it either way.
type CodegenReason = PropProblem | "malformed_doc" | "unknown_component" | "reserved_component" | "parent_takes_no_children";
/**
 * Either the file or the reason there is none. Refusing is the point: a document whose design
 * system has changed under it (a prop that no longer exists, a component that was dropped) must not
 * be quietly generated WITHOUT that prop. Epic 5 reads the file back into a tree, so a silent drop
 * here is a deletion from the document on the round trip.
 *
 * It never throws. The caller is a queue handler: an exception there is a job that fails as
 * `internal`, while a reason is something the user can be shown.
 */
export type Generated = { ok: true; tsx: string } | { ok: false; reason: CodegenReason; detail: string };

type Frame = { open: string; depth: number } | { close: string; depth: number };
type Refuse = (reason: CodegenReason, detail: string) => Generated;

export function generate(doc: Doc, manifest: Manifest): Generated {
  const no: Refuse = (reason, detail) => ({ ok: false, reason, detail });
  // The safety net. checkDoc below names every malformed shape it knows; this is what makes
  // "it returns a reason" true of ANY input rather than only of the inputs somebody listed —
  // a `nodes` that is null, a `props` that is null, a props bag whose getter throws. Writing
  // those three as named guards instead was two more lines that no test could tell apart from
  // this one, so they are gone: the net is the promise, and checkDoc is the diagnosis.
  try {
    return project(doc, manifest, no);
  } catch (err) {
    // `detail` is for the log; the user only ever sees the reason.
    return no("malformed_doc", describe(err));
  }
}

/** The net must not tear on what it catches: `String(x)` and even `instanceof` can throw. */
function describe(err: unknown): string {
  try {
    const message: unknown = err instanceof Error ? err.message : String(err);
    return typeof message === "string" ? message : "an exception";
  } catch {
    return "an exception that cannot be described";
  }
}

function project(doc: Doc, manifest: Manifest, no: Refuse): Generated {
  // doc-model already answers "every way a document could be malformed", and it is fuzzed: a
  // missing root, a root with a parent, a node stored under the wrong key, a `children` that is not
  // an array, a dangling child, a shared child, a cycle, a node nothing points at. Asking it is
  // cheaper AND stronger than a second opinion written here, and it runs before the walk, so the
  // walk can be about code rather than about shapes.
  const problems = checkDoc(doc);
  if (problems.length > 0) return no("malformed_doc", problems.slice(0, 3).join("; "));

  const spec = new Map(manifest.components.map((component) => [component.name, component]));
  const used = new Set<string>();
  const lines: string[] = [];
  // Three things below are belt and braces behind checkDoc, and a mutation test cannot tell them
  // apart from nothing: this `seen` set, the "no such node" refusal, and reaching for `nodeOf`
  // rather than `doc.nodes[id]`. checkDoc has already refused every cycle, shared child, dangling
  // id and prototype-shadowed key by the time the walk starts. They stay because this loop must
  // END and must read the document, not Object.prototype, even on the day checkDoc is wrong.
  const seen = new Set<string>();
  // An explicit stack, not recursion: `maxDepth` is the room's rule, not this function's, and a
  // document restored from a snapshot can be deeper than any call stack.
  const stack: Frame[] = [{ open: doc.rootId, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const indent = INDENT.repeat(Math.min(frame.depth + 2, MAX_INDENT_DEPTH));
    if ("close" in frame) {
      lines.push(`${indent}</${frame.close}>`);
      continue;
    }

    const id = frame.open;
    if (!isNodeId(id)) return no("malformed_doc", `${id}: not a usable node id`);
    if (seen.has(id)) return no("malformed_doc", `${id}: reachable more than once`);
    seen.add(id);
    const node = nodeOf(doc, id);
    if (!node) return no("malformed_doc", `${id}: no such node`);

    const attrs = [`data-node-id="${id}"`];
    let tag = "div";
    if (frame.depth === 0) {
      if (node.component !== ROOT_COMPONENT) return no("malformed_doc", `${id}: the root must be ${ROOT_COMPONENT}, not ${node.component}`);
      if (Object.keys(node.props).length > 0) return no("malformed_doc", `${id}: the root cannot have props`);
    } else {
      // A string, or nothing: a value that is converted to a string once for the check and again for
      // the file can answer differently each time (a lying toString put `alert(1)` in the file).
      if (typeof node.component !== "string") return no("malformed_doc", `${id}: the component name is not a string`);
      if (node.component === ROOT_COMPONENT) return no("reserved_component", `${id}: ${ROOT_COMPONENT} is the generated page component's own name`);
      const component = spec.get(node.component);
      if (!component) return no("unknown_component", `${id}: the design system has no ${node.component}`);
      if (!isIdentifier(node.component)) return no("malformed_doc", `${node.component}: not a usable component name`);
      if (node.children.length > 0 && !component.acceptsChildren) return no("parent_takes_no_children", `${id}: ${node.component} takes no children`);
      // Every OWN key, not only the enumerable strings: `Object.hasOwn` (the required-prop check
      // below) sees a hidden prop, so a walk that did not would drop it while calling the file
      // complete. `Reflect.ownKeys` also counts Symbol keys, so one comparison refuses both.
      if (Reflect.ownKeys(node.props).length !== Object.keys(node.props).length) return no("malformed_doc", `${id}: a prop is hidden (not enumerable, or keyed by a Symbol)`);
      for (const key of Object.keys(node.props).sort()) {
        const value = node.props[key];
        // `Object.hasOwn` says this prop is present and reading it says it is not. Leaving it out
        // would be the silent drop this module exists to prevent: for a required prop the file
        // would not compile, and for an optional one it WOULD compile, and epic 5 would read the
        // file back as a document with the prop deleted.
        if (value === undefined) return no("malformed_doc", `${id}: ${node.component}.${key} holds no value`);
        const problem = checkProp(component, key, value);
        if (problem) return no(problem, `${id}: ${node.component}.${key}`);
        if (!isIdentifier(key)) return no("malformed_doc", `${key}: not a usable prop name`);
        // The literal is chosen from the VALUE, never from what the manifest says the value is.
        // Asking checkProp and believing it turns a prop type nobody wrote a case for into a way to
        // write arbitrary source: `String(anObjectWithAToString)` would land in the file verbatim.
        const literal = jsLiteral(value);
        if (literal === undefined) return no("malformed_doc", `${id}: ${node.component}.${key} is not a value this generator can write`);
        attrs.push(`${key}={${literal}}`);
      }
      const missing = component.props.find((prop) => prop.required && !Object.hasOwn(node.props, prop.name));
      if (missing) return no("missing_required_prop", `${id}: ${node.component}.${missing.name}`);
      used.add(node.component);
      tag = node.component;
    }

    const open = `${indent}<${tag} ${attrs.join(" ")}`;
    if (node.children.length === 0) {
      lines.push(`${open} />`);
      continue;
    }
    lines.push(`${open}>`);
    stack.push({ close: tag, depth: frame.depth });
    // Reversed, because a stack hands back what went on last: the children must be emitted in order.
    for (const child of [...node.children].reverse()) stack.push({ open: child, depth: frame.depth + 1 });
  }

  const importLine = used.size > 0 ? [`import { ${[...used].sort().join(", ")} } from "${DESIGN_SYSTEM}";`, ""] : [];
  // The ONLY export is the page component. Fast Refresh keeps React state across an edit only while
  // a module exports components alone; one extra export turns every edit into a full page reload,
  // which is the mechanism E4.3's "an edit shows within 3 s without a full reload" rests on.
  return { ok: true, tsx: [BANNER, "", ...importLine, "export function Page() {", "  return (", ...lines, "  );", "}", ""].join("\n") };
}

/**
 * One prop value as JavaScript source, or `undefined` when there is no honest way to write it.
 *
 * Every value is a JSX EXPRESSION, never a quoted attribute: JSX string attributes have no
 * backslash escapes, so `label="a \n b"` would put those two characters in the page. A JSON literal
 * is legal JavaScript for every string the contract allows. A number that is not finite is refused
 * rather than written, because `String(NaN)` is the bare identifier `NaN`: it compiles, and it is
 * not the document's value.
 *
 * The final `return undefined` is belt and braces behind checkProp, which already refuses every
 * value that is not a string, number or boolean: a mutation test cannot reach it. It stays because
 * the alternative fallback, `String(value)`, is how an object's `toString` becomes source code.
 */
function jsLiteral(value: unknown): string | undefined {
  if (typeof value === "string") return JSON.stringify(value);
  // String(-0) is "0": a different number. validate() accepts -0, so it is written, not refused.
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? "-0" : String(value)) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}
