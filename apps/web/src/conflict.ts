import type { Conflict, ConflictReason } from "@noon/contracts";

/**
 * Why a pushed file was not applied, in the user's words. A Record over the WHOLE contract, like reasons.ts:
 * a reason added there stops this file compiling until someone has written its sentence.
 */
const SENTENCES: Record<ConflictReason, string> = {
  unknown_prop: "It sets a property its component does not have.",
  wrong_prop_type: "It gives a property a value of the wrong type.",
  missing_required_prop: "It leaves out a required property.",
  malformed_doc: "It does not describe a valid page.",
  unknown_component: "It uses a component the design system does not have.",
  reserved_component: "It uses a component that only the page itself may be.",
  parent_takes_no_children: "It puts elements inside a component that cannot hold any.",
  too_large: "It is larger than a page may be.",
  too_deep: "It nests elements more deeply than a page may.",
  syntax_error: "It is not valid TypeScript.",
  extra_statement: "It contains code besides the page itself.",
  hook: "It uses a React hook.",
  second_export: "It exports something besides the page.",
  not_page_component: "It does not export the page component.",
  bad_import: "It imports something besides the design system.",
  spread: "It spreads props instead of writing each one.",
  conditional: "It shows an element only under a condition.",
  map: "It builds elements in a loop.",
  non_literal_prop: "It computes a property instead of writing its value.",
  text_child: "It puts text directly inside an element.",
  expression_child: "It puts an expression where an element belongs.",
  not_an_element: "It returns something other than one element.",
  missing_node_id: "An element has no data-node-id.",
  bad_node_id: "An element's data-node-id is not valid.",
  duplicate_node_id: "Two elements share a data-node-id.",
  duplicate_prop: "An element sets the same property twice.",
  root_mismatch: "Its page is not this document's page.",
  reused_node_id: "It brings back an element that was removed from this document.",
  component_changed: "It changes which component an element is.",
  deleted: "It deletes this page's file.",
  not_a_file: "The page's file is no longer a regular file.",
};

/** What the banner says, as plain strings: the caller renders them as TEXT (commit and file are an engineer's). */
export function conflictWords(conflict: Conflict): { commit: string; file: string; why: string } {
  return { commit: conflict.commit, file: conflict.file, why: conflict.detail === "" ? SENTENCES[conflict.reason] : `${SENTENCES[conflict.reason]} (${conflict.detail})` };
}
