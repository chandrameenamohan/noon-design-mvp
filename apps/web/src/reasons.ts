import type { Rejection } from "@noon/peer-client";

/**
 * Why an edit did not happen, in the user's words. A Record over the WHOLE union: add a reason to
 * the contract and this file stops compiling until someone has written its sentence (the same
 * trick as the `never` check in doc-model's switch, for data instead of control flow).
 */
const SENTENCES: Record<Rejection["reason"] | "not_ready" | "invalid_op" | "too_many_pending" | "read_only", string> = {
  gone: "That element no longer exists.",
  cycle: "An element cannot be moved inside itself.",
  duplicate_node: "That element already exists.",
  root_is_fixed: "The page itself cannot be moved or removed.",
  unknown_component: "This design system has no such component.",
  parent_takes_no_children: "That element cannot hold other elements.",
  unknown_prop: "That component has no such property.",
  wrong_prop_type: "That value is not valid for this property.",
  missing_required_prop: "This property is required and cannot be cleared.",
  document_limit: "The document is as large or as deep as it may get.",
  stale: "This edit could not be saved: you were disconnected for too long.",
  unavailable: "The server could not save this edit.",
  rate_limited: "You are editing faster than the server accepts.",
  connection_closed: "This edit was not saved: the connection ended.",
  not_ready: "The document has not loaded yet.",
  invalid_op: "That value is too large or contains characters that cannot be stored.",
  too_many_pending: "Too many unsaved edits: wait for the connection to return.",
  read_only: "The document is read-only for now: the server cannot save edits.",
};
export const sentenceFor = (reason: keyof typeof SENTENCES): string => SENTENCES[reason];
