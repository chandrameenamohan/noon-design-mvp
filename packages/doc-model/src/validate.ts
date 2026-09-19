import type { Doc, Manifest, Op, PropValue } from "@noon/contracts";

/**
 * Why an op is refused. One reason is special: "gone" means the node (or the parent it targets) no
 * longer exists, which is what a concurrent remove looks like. The user did nothing wrong, so a
 * client drops such an op quietly; every other reason is shown to the sender (SPEC F5, F6).
 */
type RejectReason =
  | "gone"
  | "cycle"
  | "duplicate_node"
  | "root_is_fixed"
  | "unknown_component"
  | "parent_takes_no_children"
  | "unknown_prop"
  | "wrong_prop_type"
  | "missing_required_prop";

type Verdict = { ok: true } | { ok: false; reason: RejectReason };

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
    const node = doc.nodes[nodeId];
    return node !== undefined && (node.component === ROOT_COMPONENT || component(node.component)?.acceptsChildren === true);
  };

  switch (op.type) {
    case "add_node": {
      if (doc.nodes[op.nodeId]) return no("duplicate_node");
      if (!doc.nodes[op.parentId]) return no("gone");
      const spec = component(op.component);
      if (!spec) return no("unknown_component"); // also covers the reserved "Page"
      if (!acceptsChildren(op.parentId)) return no("parent_takes_no_children");
      for (const [key, value] of Object.entries(op.props)) {
        const problem = checkProp(spec, key, value);
        if (problem) return no(problem);
      }
      const missing = spec.props.some((p) => p.required && !(p.name in op.props));
      return missing ? no("missing_required_prop") : OK;
    }
    case "move_node": {
      const node = doc.nodes[op.nodeId];
      if (!node || !doc.nodes[op.newParentId]) return no("gone");
      if (node.parentId === null) return no("root_is_fixed");
      for (let at: string | null | undefined = op.newParentId; at != null; at = doc.nodes[at]?.parentId) {
        if (at === op.nodeId) return no("cycle");
      }
      return acceptsChildren(op.newParentId) ? OK : no("parent_takes_no_children");
    }
    case "remove_node": {
      const node = doc.nodes[op.nodeId];
      if (!node) return no("gone");
      return node.parentId === null ? no("root_is_fixed") : OK;
    }
    case "set_prop": {
      const node = doc.nodes[op.nodeId];
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

function checkProp(spec: Manifest["components"][number], key: string, value: PropValue | null): RejectReason | undefined {
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
  }
}
