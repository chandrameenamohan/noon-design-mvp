import type { Manifest } from "@noon/contracts";

/**
 * The inspector's pure part (E10.4): a manifest prop -> the ONE control its type asks for, and which of a
 * component's props are auto-layout. Nothing here knows a component by name: a new prop in a regenerated
 * manifest gets its control with no code change, and a kind the mapping does not know throws instead of
 * rendering nothing (a prop without a control is a prop nobody can edit).
 */
type Component = Manifest["components"][number];
export type Prop = Component["props"][number];

/** How many choices a segmented control holds before it becomes a select: five would not fit the pane. */
export const SEGMENTED_MAX = 4;

/**
 * `placeholder` is what an UNSET text or number field shows (the manifest default, "required" when there
 * is none and the prop must be set); `fallback` is the state an unset toggle or choice shows.
 */
export type Control =
  | { kind: "text"; prop: Prop; placeholder: string }
  | { kind: "number"; prop: Prop; placeholder: string }
  | { kind: "toggle"; prop: Prop; fallback: boolean }
  | { kind: "segmented"; prop: Prop; options: string[]; fallback: string | undefined }
  | { kind: "select"; prop: Prop; options: string[]; fallback: string | undefined };

export function controlFor(prop: Prop): Control {
  const placeholder = prop.default === undefined ? (prop.required ? "required" : "") : String(prop.default);
  const type = prop.type;
  switch (type.kind) {
    case "string":
      return { kind: "text", prop, placeholder };
    case "number":
      return { kind: "number", prop, placeholder };
    case "boolean":
      return { kind: "toggle", prop, fallback: prop.default === true };
    case "enum": {
      const fallback = typeof prop.default === "string" ? prop.default : undefined;
      return { kind: type.options.length <= SEGMENTED_MAX ? "segmented" : "select", prop, options: type.options, fallback };
    }
    default: {
      // The compiler's check that every kind above is handled, and the runtime's answer when a manifest
      // from a newer extractor arrives with a kind this build has never heard of.
      const unknown: never = type;
      throw new Error(`no control for prop kind ${JSON.stringify((unknown as { kind?: unknown }).kind)} (${prop.name})`);
    }
  }
}

/**
 * The auto-layout props, by NAME AND KIND: `gap` as a number is a stepper that shades the space between
 * children; `gap` as a string is just a string. Free width and height are out of scope (E10.4), so they
 * are not here. ponytail: per-side padding lands here the day the manifest declares it.
 */
export type LayoutName = "direction" | "gap" | "padding" | "align";
export const LAYOUT_PROPS: Readonly<Record<LayoutName, Prop["type"]["kind"]>> = { direction: "enum", gap: "number", padding: "number", align: "enum" };
/** The layout props that stand for a SPACE the canvas can shade while their control is hovered or focused. */
export type Space = Extract<LayoutName, "gap" | "padding">;

const isLayoutName = (name: string): name is LayoutName => Object.hasOwn(LAYOUT_PROPS, name);
export const layoutNameOf = (prop: Prop): LayoutName | undefined => (isLayoutName(prop.name) && LAYOUT_PROPS[prop.name] === prop.type.kind ? prop.name : undefined);
export const isLayoutProp = (prop: Prop): boolean => layoutNameOf(prop) !== undefined;
export const spaceOf = (prop: Prop): Space | undefined => { const name = layoutNameOf(prop); return name === "gap" || name === "padding" ? name : undefined; };

/** A component's props in two sections, each in the manifest's own order. */
export function splitProps(component: Component): { layout: Prop[]; props: Prop[] } {
  return { layout: component.props.filter(isLayoutProp), props: component.props.filter((p) => !isLayoutProp(p)) };
}

/**
 * Direction and alignment options drawn as arrows, when the option is one CSS flexbox names; the name
 * stays the accessible label either way, and an option the table does not know is shown by its name.
 */
const GLYPHS: Readonly<Record<string, string>> = { row: "→", column: "↓", "row-reverse": "←", "column-reverse": "↑", start: "⇤", center: "↔", end: "⇥", stretch: "⇿" };
export const glyphFor = (option: string): string | undefined => GLYPHS[option];
