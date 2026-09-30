import type { RunStep } from "@noon/contracts";

// Our tools, in the user's words. The list is OPEN (a newer worker may have a tool this build does not know): an
// unknown one is shown by its name, never dropped. A Map: a tool named "constructor" must find nothing, not Object.prototype's.
const DOING = new Map(Object.entries({
  read_tree: "Read the page",
  read_manifest: "Read the design system",
  add_node: "Added",
  set_prop: "Set",
  move_node: "Moved",
  remove_node: "Removed",
}));

/** F30: one step of a run as a line of TEXT. `detail` is the model's own words: React renders it as text, never markup. */
export function stepText(step: RunStep): string {
  const line = [DOING.get(step.tool) ?? step.tool, step.detail].filter((part) => part !== "").join(" ");
  return step.ok ? line : `${line}: not applied`;
}
