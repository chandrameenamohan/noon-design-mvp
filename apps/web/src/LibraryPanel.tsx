import { createElement, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Doc, Manifest } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { components, THUMB, thumbStylesheet } from "./designSystem.ts";
import { placementAt, type Placement } from "./layer-moves.ts";
import { previewProps, slotForDrop, slotForSelection, type Slot } from "./library-adds.ts";
import { actionFor } from "./shortcuts.ts";
import { slotUnder } from "./Surface.tsx";

/**
 * The library (E10.5): every component the manifest names, as a searchable listbox of tiles, each the REAL
 * component rendered small (a Button IS the sample app's Button) with its name under it. It replaces the
 * "Add X" toolbar.
 *
 * Three ways to add, all ONE add_node through the caller's `onAdd` (library-adds.ts decides the slot):
 * Enter or Space on a tile, or a click, adds into the selected element (after it when it holds no
 * children); a drag carries the tile over the layers tree (a line before or after a row, a box round a
 * container, read exactly as the tree reads its own drags) or over the canvas (a box round the parent
 * and a line among its children, measured by Surface.tsx), and letting go adds it there. The caller
 * selects the new node.
 *
 * Roving tabindex like the tree: the active tile holds the one tab stop, arrows move it, the search box
 * above narrows the list. The tiles are inert and hidden from assistive technology: a tile's name is the
 * component's, not its sample text.
 * ponytail: a fixed two-column grid whose arrows walk the list in reading order (six components); a
 * real grid role with row/column movement is the upgrade when a design system outgrows the pane.
 */
type Component = Manifest["components"][number];

/** What a carried component is over: a row of the tree (and how the tree should mark it), or a slot on the canvas. */
export type Carry =
  | { kind: "tree"; targetId: string; placement: Placement; slot: Slot | null }
  | { kind: "canvas"; slot: Slot };

type Props = {
  doc: Doc;
  selected: string;
  labels: Map<string, string>;
  /** Whether a node's component takes children: where Enter adds, and how a drag reads a row. */
  isContainer: (id: string) => boolean;
  /** Read-only (the room cannot save right now): nothing is added. */
  disabled: boolean;
  /** What the carried component is over, for the tree and the canvas to show; null when nothing is carried. */
  onCarry: (carry: Carry | null) => void;
  /** ONE add: the caller mints the id, submits the add_node and selects the new node. */
  onAdd: (component: Component, slot: Slot) => void;
};

/** A press that may become a drag: which tile, where it began, and whether it has travelled yet. */
type Press = { name: string; x: number; y: number; moved: boolean };

const componentOf = (name: string): Component | undefined => manifest.components.find((c) => c.name === name);
/** What a container holds in its tile: two stand-in children, since the manifest knows none. */
const BLOCKS = [<span key="a" className="thumb-block" />, <span key="b" className="thumb-block" />];

export function LibraryPanel({ doc, selected, labels, isContainer, disabled, onCarry, onAdd }: Props) {
  const list = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(manifest.components[0]?.name ?? "");
  // The tile being dragged, for the eye (half transparent, a grabbing cursor); the gesture itself lives in the refs.
  const [carrying, setCarrying] = useState<string | null>(null);
  // Said, not only shown: what the last add did, for a screen reader.
  const [said, setSaid] = useState("");
  // Refs, not state: nothing on the screen renders from a press or from what the pointer is over; the parent shows that.
  const press = useRef<Press | null>(null);
  const over = useRef<Carry | null>(null);

  const shown = manifest.components.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  // The tab stop: the active tile, or the first shown one when the search hid it.
  const tabStop = shown.some((c) => c.name === active) ? active : shown[0]?.name;

  // On the canvas `data-component` names a NODE (the e2e suites count nodes by it); the sample app's components
  // stamp it on their own root, here too. Taken off after each render, as Surface.tsx does for the frame.
  useLayoutEffect(() => { list.current?.querySelectorAll("[data-component]").forEach((el) => { el.removeAttribute("data-component"); }); });

  const add = (component: Component, slot: Slot): void => {
    if (disabled) return;
    onAdd(component, slot);
    setSaid(`${component.name} added to ${labels.get(slot.parentId) ?? "the page"}, position ${String(slot.index + 1)}`);
  };
  const addToSelection = (component: Component): void => { add(component, slotForSelection(doc, selected, isContainer)); };
  const focusTile = (name: string): void => {
    setActive(name);
    list.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(name)}"]`)?.focus();
  };
  /** Tells the parent what the tile is over, once per change: the tree and the canvas draw it. */
  const carry = (next: Carry | null): void => {
    if (JSON.stringify(over.current) === JSON.stringify(next)) return;
    over.current = next;
    onCarry(next);
  };
  const endDrag = (): void => { press.current = null; setCarrying(null); carry(null); };

  // --- the pointer: press focuses; a press that travels becomes a drag; letting go adds -----------------
  const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>, name: string): void => {
    if (event.button !== 0) return;
    focusTile(name);
    press.current = { name, x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLUListElement>): void => {
    const p = press.current;
    if (!p || disabled) return;
    if (!p.moved) {
      if (Math.hypot(event.clientX - p.x, event.clientY - p.y) < 4) return;
      p.moved = true;
      setCarrying(p.name);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks: the drag still works while it stays over the page */ }
    }
    // Captured, so the events come here whatever is under the pointer; the DOM says what that is.
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const row = under?.closest<HTMLElement>("[role=treeitem]") ?? null;
    const canvas = under?.closest<HTMLElement>(".canvas") ?? null;
    const targetId = row?.dataset["nodeId"];
    if (row && targetId !== undefined) {
      const box = row.getBoundingClientRect();
      const placement = placementAt((event.clientY - box.top) / box.height, isContainer(targetId));
      carry({ kind: "tree", targetId, placement, slot: slotForDrop(doc, { targetId, placement }) });
    } else if (canvas) {
      const slot = slotUnder(canvas, { x: event.clientX, y: event.clientY }, doc, isContainer);
      carry(slot ? { kind: "canvas", slot } : null);
    } else carry(null);
  };
  const onPointerUp = (): void => {
    const p = press.current;
    if (!p) return;
    const component = componentOf(p.name);
    // A click (never travelled) adds where Enter would; a drag adds where it was let go, if that is a place.
    if (component && !p.moved) addToSelection(component);
    else if (component && over.current?.slot) add(component, over.current.slot);
    endDrag();
  };

  // --- the keyboard (WAI-ARIA APG listbox: arrows, Home, End; Enter and Space add); the keys are the registry's (shortcuts.ts) ---
  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    const name = (event.target as HTMLElement).closest<HTMLElement>("[role=option]")?.dataset["name"];
    const action = actionFor("library", event);
    if (name === undefined || action === null) return;
    const at = shown.findIndex((c) => c.name === name);
    if (action === "next") { const next = shown[at + 1]; if (next) focusTile(next.name); }
    else if (action === "previous") { const previous = shown[at - 1]; if (previous) focusTile(previous.name); }
    else if (action === "first") { const first = shown[0]; if (first) focusTile(first.name); }
    else if (action === "last") { const last = shown.at(-1); if (last) focusTile(last.name); }
    else if (action === "add") { const component = componentOf(name); if (component) addToSelection(component); }
    else if (press.current) endDrag(); // "cancel"
    else return;
    event.preventDefault();
  };

  return (
    <div className="library" data-dragging={carrying === null ? undefined : ""}>
      <style>{thumbStylesheet}</style>
      <input
        type="search"
        className="library-search"
        aria-label="Search components"
        placeholder="Search"
        value={query}
        onChange={(event) => { setQuery(event.target.value); }}
        onKeyDown={(event) => { if (actionFor("search", event) === "list" && tabStop !== undefined) { event.preventDefault(); focusTile(tabStop); } }}
      />
      <ul
        ref={list}
        role="listbox"
        aria-label="Components"
        aria-describedby={hintId}
        className="library-list"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {shown.map((component) => {
          const Component = components[component.name];
          return (
            <li
              key={component.name}
              role="option"
              aria-selected={component.name === active}
              aria-disabled={disabled ? true : undefined}
              tabIndex={component.name === tabStop ? 0 : -1}
              data-name={component.name}
              data-dragging={carrying === component.name ? "" : undefined}
              className="library-item"
              onPointerDown={(event) => { onPointerDown(event, component.name); }}
            >
              {/* Inert AND hidden: the real component takes no clicks and no focus, and its sample text is not the tile's name. */}
              <span className="thumb" aria-hidden="true" inert>
                <span className={THUMB}>{Component ? createElement(Component, previewProps(component), component.acceptsChildren ? BLOCKS : undefined) : component.name}</span>
              </span>
              <span className="library-name">{component.name}</span>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="hint">No component is called that.</p>}
      <p id={hintId} className="visually-hidden">Arrow keys move between components. Enter adds the component into the selected element, or after it when it holds no children. Drag a component onto the canvas or onto a layer to place it exactly.</p>
      <p aria-live="polite" className="visually-hidden">{said}</p>
    </div>
  );
}
