import type { Manifest } from "@noon/contracts";

/**
 * A fake design system for tests, shared so that doc-model's rules and codegen's output are judged
 * against the SAME components: two copies would drift the day one of them grows a prop kind.
 * It covers every prop kind, a component that takes children and two that do not, and three names
 * whose alphabetical order is not the order a tree reaches them.
 */
export const testManifest: Manifest = {
  version: 1,
  components: [
    { name: "Stack", acceptsChildren: true, props: [{ name: "gap", type: { kind: "number" }, required: false, default: 8 }, { name: "direction", type: { kind: "enum", options: ["column", "row"] }, required: false, default: "column" }] },
    { name: "Button", acceptsChildren: false, props: [{ name: "label", type: { kind: "string" }, required: true }, { name: "disabled", type: { kind: "boolean" }, required: false, default: false }] },
    { name: "Alert", acceptsChildren: false, props: [] },
  ],
};
