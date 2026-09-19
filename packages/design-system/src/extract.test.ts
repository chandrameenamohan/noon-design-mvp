import { expect, test } from "vitest";
import { Manifest } from "@noon/contracts";
import { extractManifest, serializeManifest } from "./extract.ts";

const ENTRY = new URL("../../../seed/sample-app/src/design-system/index.ts", import.meta.url).pathname;
const manifest = extractManifest(ENTRY);
const component = (name: string) => {
  const found = manifest.components.find((c) => c.name === name);
  if (!found) throw new Error(`no component ${name}`);
  return found;
};
const prop = (c: string, p: string) => component(c).props.find((x) => x.name === p);

test("finds exactly the six exported components, sorted, and the result satisfies the contract", () => {
  expect(manifest.components.map((c) => c.name)).toEqual(["Button", "Card", "Image", "Input", "Stack", "Text"]);
  expect(Manifest.parse(manifest)).toEqual(manifest);
});

test("a string-literal union becomes an enum with its options and its default", () => {
  expect(prop("Button", "variant")).toEqual({ name: "variant", type: { kind: "enum", options: ["ghost", "primary", "secondary"] }, required: false, default: "primary" });
  expect(prop("Stack", "direction")).toMatchObject({ type: { kind: "enum", options: ["column", "row"] }, default: "column" });
});

test("primitives, required-ness and defaults are read correctly", () => {
  expect(prop("Button", "label")).toEqual({ name: "label", type: { kind: "string" }, required: true });
  expect(prop("Button", "disabled")).toEqual({ name: "disabled", type: { kind: "boolean" }, required: false, default: false });
  expect(prop("Stack", "gap")).toEqual({ name: "gap", type: { kind: "number" }, required: false, default: 8 });
  expect(prop("Image", "alt")).toMatchObject({ required: true, type: { kind: "string" } });
  expect(prop("Card", "title")).toEqual({ name: "title", type: { kind: "string" }, required: false }); // optional, no default
});

test("children is not a prop: it becomes acceptsChildren", () => {
  expect(component("Stack").acceptsChildren).toBe(true);
  expect(component("Card").acceptsChildren).toBe(true);
  expect(component("Button").acceptsChildren).toBe(false);
  expect(prop("Stack", "children")).toBeUndefined();
});

test("serialization is stable: the same input gives byte-identical JSON", () => {
  expect(serializeManifest(extractManifest(ENTRY))).toBe(serializeManifest(manifest));
  expect(serializeManifest(manifest).endsWith("\n")).toBe(true);
});
