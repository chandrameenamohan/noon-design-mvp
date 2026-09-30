import type { Doc, Manifest, Op } from "@noon/contracts";
import type { Placement } from "./layer-moves.ts";
import type { Rect } from "./spaces.ts";

/**
 * How the library turns a drop, a key or a click into ONE add_node (E10.5). Pure: the panel measures the
 * DOM and calls in here; nothing here writes to the document.
 *
 * Every path ends in a Slot (a parent and an index among its children), and a slot becomes the op. Like
 * layer-moves.ts it refuses only what is structurally impossible on the document it can see (beside the
 * page, onto a node that is gone); whether the parent takes children is the replica's and the room's
 * verdict, shown as their refusal.
 */
export type AddOp = Extract<Op, { type: "add_node" }>;
type Component = Manifest["components"][number];
/** A place a new node can take: its parent, and its FINAL index among the parent's children. */
export type Slot = { parentId: string; index: number };

/** The props a new node must have: the manifest says which are required, and of what type. */
export function requiredProps(component: Component): AddOp["props"] {
  const props: Record<string, string | number | boolean> = {};
  for (const prop of component.props.filter((p) => p.required)) {
    props[prop.name] = prop.type.kind === "string" ? component.name : prop.type.kind === "number" ? 0 : prop.type.kind === "boolean" ? false : (prop.type.options[0] ?? "");
  }
  return props;
}

/** The op a slot means. `nodeId` is minted by the caller: random, never reused (SPEC §2.4). */
export function addOpAt(slot: Slot, component: Component, nodeId: string): AddOp {
  return { type: "add_node", nodeId, parentId: slot.parentId, index: slot.index, component: component.name, props: requiredProps(component) };
}

/** Beside `id` in its parent, one past it. Null for the page: there is no such place. */
function after(doc: Doc, id: string): Slot | null {
  const node = doc.nodes[id];
  if (!node || node.parentId === null) return null;
  const parent = doc.nodes[node.parentId];
  return parent ? { parentId: parent.id, index: parent.children.indexOf(id) + 1 } : null;
}
const end = (doc: Doc, id: string): Slot => ({ parentId: id, index: doc.nodes[id]?.children.length ?? 0 });

/**
 * A drop on the layers tree, read the way the tree reads its own drags (layer-moves.ts placementAt):
 * before or after a row is a sibling of it, into a row is its last child.
 */
export function slotForDrop(doc: Doc, drop: { targetId: string; placement: Placement }): Slot | null {
  const target = doc.nodes[drop.targetId];
  if (!target) return null;
  if (drop.placement === "into") return end(doc, target.id);
  if (target.parentId === null) return null; // beside the page
  const parent = doc.nodes[target.parentId];
  return parent ? { parentId: parent.id, index: parent.children.indexOf(target.id) + (drop.placement === "after" ? 1 : 0) } : null;
}

/**
 * A drop on the canvas: `hit` is the node under the pointer (selection.ts hitTest), null for the empty sheet.
 * A container takes the component at the index the pointer says among its children (`indexIn`, measured by
 * the caller only when asked: the boxes are the DOM's); a leaf puts it right after itself in its parent.
 */
export function slotOnCanvas(doc: Doc, hit: string | null, isContainer: (id: string) => boolean, indexIn: (containerId: string) => number): Slot | null {
  const id = hit ?? doc.rootId;
  if (!doc.nodes[id]) return null;
  if (isContainer(id)) return { parentId: id, index: indexIn(id) };
  return after(doc, id);
}

/** Enter, or a click, on a library item: into the selected container at the end, after a selected leaf, onto the page otherwise. */
export function slotForSelection(doc: Doc, selected: string, isContainer: (id: string) => boolean): Slot {
  if (!doc.nodes[selected]) return end(doc, doc.rootId);
  if (isContainer(selected)) return end(doc, selected);
  return after(doc, selected) ?? end(doc, doc.rootId);
}

/** A child's extent along the layout axis (left/right for a row, top/bottom for a column). */
export type Extent = { start: number; end: number };

/** How many children the pointer has passed the middle of: that is the index the new one takes among them. */
export function indexAlong(children: readonly Extent[], position: number): number {
  return children.filter((child) => position >= (child.start + child.end) / 2).length;
}

export type Axis = "x" | "y";

/**
 * Where the drop line goes for a slot at `index` among `children` inside a parent's content box: a zero-thick
 * rectangle across the box on the other axis (the CSS gives it a stroke). At a child's start edge, in the
 * middle of the gap between two, after the last, or at the box's start when it is empty.
 */
export function insertLineAt(inner: Rect, children: readonly Rect[], axis: Axis, index: number): Rect {
  const along = (r: Rect): Extent => (axis === "x" ? { start: r.left, end: r.right } : { start: r.top, end: r.bottom });
  const at = Math.min(index, children.length);
  const before = children[at - 1];
  const here = children[at];
  const position = before && here ? (along(before).end + along(here).start) / 2 : here ? along(here).start : before ? along(before).end : along(inner).start;
  return axis === "x" ? { left: position, top: inner.top, right: position, bottom: inner.bottom } : { left: inner.left, top: position, right: inner.right, bottom: position };
}

/** A grey rectangle, inline: what the thumbnail shows for an image prop, so no request is made for a name that is not an address. */
const PLACEHOLDER_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="56"><rect width="96" height="56" rx="8" fill="#c4cad3"/></svg>')}`;

/**
 * What the library renders a component with: its required props, except that a `src` gets the inline image.
 * ponytail: keyed on the prop's NAME, the one convention the manifest does not declare; a `preview` field
 * in the manifest is the upgrade when a real design system arrives.
 */
export function previewProps(component: Component): AddOp["props"] {
  const props = requiredProps(component);
  for (const prop of component.props) if (prop.name === "src" && prop.type.kind === "string") props[prop.name] = PLACEHOLDER_IMAGE;
  return props;
}
