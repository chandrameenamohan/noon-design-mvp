import type { Doc, Manifest } from "@noon/contracts";
import { checkProp, nodeOf, type PropProblem } from "@noon/doc-model";

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
/** The root node is the page itself: it is never placed, moved, removed or given props (doc-model). */
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
type CodegenReason = PropProblem | "malformed_doc" | "unknown_component" | "parent_takes_no_children";
/**
 * Either the file or the reason there is none. Refusing is the point: a document whose design
 * system has changed under it (a prop that no longer exists, a component that was dropped) must not
 * be quietly generated WITHOUT that prop. Epic 5 reads the file back into a tree, so a silent drop
 * here is a deletion from the document on the round trip.
 */
export type Generated = { ok: true; tsx: string } | { ok: false; reason: CodegenReason; detail: string };

type Frame = { open: string; depth: number } | { close: string; depth: number };

export function generate(doc: Doc, manifest: Manifest): Generated {
  const no = (reason: CodegenReason, detail: string): Generated => ({ ok: false, reason, detail });
  const spec = new Map(manifest.components.map((component) => [component.name, component]));
  const used = new Set<string>();
  const lines: string[] = [];
  // A document from outside may hold a cycle or a shared child; this walk must end either way.
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
      const component = spec.get(node.component);
      if (!component) return no("unknown_component", `${id}: the design system has no ${node.component}`);
      if (!isIdentifier(node.component)) return no("malformed_doc", `${node.component}: not a usable component name`);
      if (node.children.length > 0 && !component.acceptsChildren) return no("parent_takes_no_children", `${id}: ${node.component} takes no children`);
      for (const key of Object.keys(node.props).sort()) {
        const value = node.props[key];
        if (value === undefined) continue;
        const problem = checkProp(component, key, value);
        if (problem) return no(problem, `${id}: ${node.component}.${key}`);
        if (!isIdentifier(key)) return no("malformed_doc", `${key}: not a usable prop name`);
        // Every value is a JSX EXPRESSION, never a quoted attribute: JSX string attributes have no
        // backslash escapes, so `label="a \n b"` would put the two characters in the page. A
        // JSON literal is legal JavaScript for every string the contract allows.
        attrs.push(`${key}={${typeof value === "string" ? JSON.stringify(value) : String(value)}}`);
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
