import { expect, test } from "vitest";
import type { Manifest } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { controlFor, glyphFor, isLayoutProp, SEGMENTED_MAX, splitProps, type Prop } from "./controls.ts";

// unit:control-for-every-manifest-prop (E10.4): the inspector is the manifest, rendered. Every prop the
// committed manifest declares maps to exactly one control, and a kind the mapping does not know FAILS
// instead of rendering nothing: a prop without a control is a prop nobody can edit.

const prop = (name: string, type: Prop["type"], rest: Partial<Prop> = {}): Prop => ({ name, type, required: false, ...rest });

test("every prop of every component in the committed manifest gets a control of the kind its type asks for", () => {
  const KIND_TO_CONTROL = { string: ["text"], number: ["number"], boolean: ["toggle"], enum: ["segmented", "select"] };
  let seen = 0;
  for (const component of manifest.components) {
    for (const each of component.props) {
      const control = controlFor(each);
      expect(KIND_TO_CONTROL[each.type.kind], `${component.name}.${each.name}`).toContain(control.kind);
      expect(control.prop).toBe(each);
      seen++;
    }
  }
  expect(seen).toBeGreaterThan(0);
});

test("an unknown prop kind fails loudly rather than rendering nothing", () => {
  const unknown = { name: "colour", type: { kind: "colour" }, required: false } as unknown as Prop;
  expect(() => controlFor(unknown)).toThrow(/colour/);
});

test("an enum is segmented up to four options and a select past that", () => {
  const four = prop("align", { kind: "enum", options: ["a", "b", "c", "d"] });
  const five = prop("variant", { kind: "enum", options: ["a", "b", "c", "d", "e"] });
  expect(four.type.kind === "enum" ? four.type.options.length : 0).toBe(SEGMENTED_MAX);
  expect(controlFor(four)).toMatchObject({ kind: "segmented", options: ["a", "b", "c", "d"] });
  expect(controlFor(five)).toMatchObject({ kind: "select", options: ["a", "b", "c", "d", "e"] });
});

test("the manifest default becomes the placeholder; a required prop without one says so; a toggle's default is its resting state", () => {
  expect(controlFor(prop("gap", { kind: "number" }, { default: 8 }))).toMatchObject({ kind: "number", placeholder: "8" });
  expect(controlFor(prop("title", { kind: "string" }))).toMatchObject({ kind: "text", placeholder: "" });
  expect(controlFor(prop("label", { kind: "string" }, { required: true }))).toMatchObject({ kind: "text", placeholder: "required" });
  expect(controlFor(prop("disabled", { kind: "boolean" }, { default: false }))).toMatchObject({ kind: "toggle", fallback: false });
  expect(controlFor(prop("open", { kind: "boolean" }, { default: true }))).toMatchObject({ kind: "toggle", fallback: true });
  expect(controlFor(prop("open", { kind: "boolean" }))).toMatchObject({ kind: "toggle", fallback: false });
  expect(controlFor(prop("size", { kind: "enum", options: ["sm", "md"] }, { default: "md" }))).toMatchObject({ kind: "segmented", fallback: "md" });
  expect(controlFor(prop("size", { kind: "enum", options: ["sm", "md"] }))).toMatchObject({ kind: "segmented", fallback: undefined });
});

// unit:layout-props-detected (E10.4): the auto-layout controls appear for the layout props a component's
// manifest DECLARES, by name and kind, and for nothing else. Nothing is keyed on a component's name.

test("the committed manifest: Stack declares direction, gap and align; Card declares padding; the leaves declare no layout", () => {
  const byName = new Map(manifest.components.map((c) => [c.name, c]));
  const layoutNames = (name: string): string[] => splitProps(byName.get(name) ?? { name, acceptsChildren: false, props: [] }).layout.map((p) => p.name);
  expect(layoutNames("Stack")).toEqual(["align", "direction", "gap"]);
  expect(layoutNames("Card")).toEqual(["padding"]);
  for (const leaf of ["Button", "Image", "Input", "Text"]) expect(layoutNames(leaf), leaf).toEqual([]);
  // The rest of a component's props stay in the Props section, in the manifest's order.
  expect(splitProps(byName.get("Card") ?? { name: "Card", acceptsChildren: true, props: [] }).props.map((p) => p.name)).toEqual(["title"]);
});

test("a layout name with the wrong kind is an ordinary prop: `gap` as a string gets a text field, not a stepper", () => {
  expect(isLayoutProp(prop("gap", { kind: "number" }))).toBe(true);
  expect(isLayoutProp(prop("gap", { kind: "string" }))).toBe(false);
  expect(isLayoutProp(prop("direction", { kind: "enum", options: ["row", "column"] }))).toBe(true);
  expect(isLayoutProp(prop("direction", { kind: "boolean" }))).toBe(false);
  expect(isLayoutProp(prop("padding", { kind: "number" }))).toBe(true);
  expect(isLayoutProp(prop("align", { kind: "enum", options: ["start"] }))).toBe(true);
  expect(isLayoutProp(prop("width", { kind: "number" }))).toBe(false); // free width is out of scope
  const component: Manifest["components"][number] = { name: "Odd", acceptsChildren: true, props: [prop("gap", { kind: "string" }), prop("padding", { kind: "number" })] };
  expect(splitProps(component)).toEqual({ layout: [component.props[1]], props: [component.props[0]] });
});

test("direction and alignment options the mapping knows get a glyph; an option it does not know is shown by its name", () => {
  expect(glyphFor("row")).toBe("→");
  expect(glyphFor("column")).toBe("↓");
  expect(glyphFor("start")).toBe("⇤");
  expect(glyphFor("stretch")).toBe("⇿");
  expect(glyphFor("space-between")).toBeUndefined();
});
