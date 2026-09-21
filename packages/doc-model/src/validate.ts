import type { Doc, Manifest, Op, PropValue, RejectReason } from "@noon/contracts";
import { nodeOf } from "./index.ts";

type Verdict = { ok: true } | { ok: false; reason: RejectReason };
/** The reasons a single prop can be wrong. A subset of RejectReason, so validate() can return one unchanged. */
export type PropProblem = Extract<RejectReason, "unknown_prop" | "wrong_prop_type" | "missing_required_prop">;

const OK: Verdict = { ok: true };
const no = (reason: RejectReason): Verdict => ({ ok: false, reason });
const ROOT_COMPONENT = "Page"; // the root is implicit: never placed, moved, removed or given props

/**
 * Decides whether the room should accept an op. PURE like applyOp, and the manifest is an ARGUMENT:
 * this module never imports one, so the same code can validate against a per-branch manifest later.
 *
 * validate() says WHY; applyOp() is total and only says WHAT. The room runs validate first, so
 * applyOp's "return the same doc" paths are the safety net, not the policy.
 */
export function validate(doc: Doc, op: Op, manifest: Manifest): Verdict {
  const component = (name: string) => manifest.components.find((c) => c.name === name);
  const acceptsChildren = (nodeId: string): boolean => {
    const node = nodeOf(doc, nodeId);
    return node !== undefined && (node.component === ROOT_COMPONENT || component(node.component)?.acceptsChildren === true);
  };

  switch (op.type) {
    case "add_node": {
      if (nodeOf(doc, op.nodeId)) return no("duplicate_node");
      const parent = nodeOf(doc, op.parentId);
      if (!parent) return no("gone");
      // The root component's name is reserved for EVERYONE, not just the root: codegen declares
      // `export function Page()`, so a design system that exported its own `Page` would generate a
      // file whose import collides with that declaration. Refused here, before the manifest is even
      // consulted, so the name cannot enter a document whatever the design system happens to export.
      if (op.component === ROOT_COMPONENT) return no("unknown_component");
      const spec = component(op.component);
      if (!spec) return no("unknown_component");
      // A parent whose component has since left the design system is not "takes no children".
      if (parent.component !== ROOT_COMPONENT && !component(parent.component)) return no("unknown_component");
      if (!acceptsChildren(op.parentId)) return no("parent_takes_no_children");
      for (const [key, value] of Object.entries(op.props)) {
        const problem = checkProp(spec, key, value);
        if (problem) return no(problem);
      }
      const missing = spec.props.some((p) => p.required && !Object.hasOwn(op.props, p.name));
      return missing ? no("missing_required_prop") : OK;
    }
    case "move_node": {
      const node = nodeOf(doc, op.nodeId);
      if (!node || !nodeOf(doc, op.newParentId)) return no("gone");
      if (node.parentId === null) return no("root_is_fixed");
      // `seen`: on a document that already HAS a cycle (one nobody ran checkDoc on) this walk would never end.
      const seen = new Set<string>();
      for (let at: string | null | undefined = op.newParentId; at != null && !seen.has(at); at = nodeOf(doc, at)?.parentId) {
        if (at === op.nodeId) return no("cycle");
        seen.add(at);
      }
      return acceptsChildren(op.newParentId) ? OK : no("parent_takes_no_children");
    }
    case "remove_node": {
      const node = nodeOf(doc, op.nodeId);
      if (!node) return no("gone");
      return node.parentId === null ? no("root_is_fixed") : OK;
    }
    case "set_prop": {
      const node = nodeOf(doc, op.nodeId);
      if (!node) return no("gone");
      if (node.parentId === null) return no("root_is_fixed");
      const spec = component(node.component);
      if (!spec) return no("unknown_component"); // the design system dropped this component since the node was placed
      const problem = checkProp(spec, op.key, op.value);
      return problem ? no(problem) : OK;
    }
    default: {
      const unreachable: never = op;
      return unreachable;
    }
  }
}

/**
 * Whether a value fits a component's prop. Exported because @noon/codegen must agree with this
 * EXACTLY: what validate() accepts into a document is what codegen has to turn into type-checking
 * TSX, and a second copy of these rules would drift the day the manifest grows a kind.
 */
export function checkProp(spec: Manifest["components"][number], key: string, value: PropValue | null): PropProblem | undefined {
  const prop = spec.props.find((p) => p.name === key);
  if (!prop) return "unknown_prop";
  if (value === null) return prop.required ? "missing_required_prop" : undefined;
  switch (prop.type.kind) {
    case "string":
      return typeof value === "string" ? undefined : "wrong_prop_type";
    case "number":
      return typeof value === "number" ? undefined : "wrong_prop_type";
    case "boolean":
      return typeof value === "boolean" ? undefined : "wrong_prop_type";
    case "enum":
      return typeof value === "string" && prop.type.options.includes(value) ? undefined : "wrong_prop_type";
    default:
      // Two guarantees, one for the compiler and one for the runtime. `satisfies never` means a
      // FIFTH PropType kind fails to compile here rather than falling off the end of the switch:
      // without it TypeScript stays silent, because the declared return type already allows
      // `undefined`. And a manifest that skipped Manifest.parse and got here anyway is answered
      // with a NAME, never `undefined`, which every caller reads as "this value is fine" and
      // codegen turns into source code on nothing but trust.
      prop.type satisfies never;
      return "wrong_prop_type";
  }
}
