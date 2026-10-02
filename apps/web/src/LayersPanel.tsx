import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Doc, Op } from "@noon/contracts";
import { dropToMoveOp, keyMoveOp, placementAt, visibleRows, type Drop, type KeyMove, type Placement, type Row } from "./layer-moves.ts";
import { actionFor, type ActionOf } from "./shortcuts.ts";

/**
 * The layers (E10.3): the document as an ARIA tree whose selection IS the canvas's selection, both ways.
 *
 * One flat list with aria-level (the APG allows it when nesting the DOM would only nest the
 * problems): every row is a treeitem, ONE row holds the tab stop (roving tabindex, the selected row
 * or, when that sits under a collapsed row, its nearest shown ancestor), arrows move focus and the
 * selection together, Left and Right close and open, Alt+arrows move the node, Delete removes it.
 * Dragging a row shows a line before or after the row under the pointer, or a box around a container
 * (layer-moves.ts decides which), and the drop sends ONE move_node through `submit`; the replica's and
 * the room's refusals come back as notices like any other edit's. The canvas and this tree render the
 * same document, so another person's move shows here the moment the room broadcasts it.
 *
 * Pointer events, not HTML drag and drop: the same gestures the canvas speaks, no ghost image to
 * fight, and the indicator follows the pointer's exact height on the row. A component carried here from
 * the library (E10.5, `insertion`) wears the same line or box: the library reads the rows the same way.
 * ponytail: no auto-scroll while dragging near the pane's edge; no type-ahead. Both are the upgrade
 * when a document outgrows one screen of layers.
 */
type Props = {
  doc: Doc;
  /** Every node in reading order, labelled and with its depth (Canvas.tsx names them). */
  rows: readonly Row[];
  selected: string;
  /** Whether a node's component takes children: how the drag tells a box from a line. */
  isContainer: (id: string) => boolean;
  onSelect: (id: string) => void;
  /** Sends one edit; false when the replica refused it (Canvas.tsx shows why, as an alert). */
  submit: (op: Op) => boolean;
  /** A component from the library carried over a row, and whether it can land there; null while none is. */
  insertion?: Insertion | null;
};

/** Where a carried component would land on the tree, as the library measured it. */
type Insertion = { targetId: string; placement: Placement; allowed: boolean };

/** A drag under way: what is held, and the row and place under the pointer, if any. `allowed` false: a place the node cannot go. */
type Drag = { nodeId: string; over: (Drop & { allowed: boolean }) | null };
type Press = { id: string; x: number; y: number };

/** The registry's four Alt moves (shortcuts.ts, scope "layers") as layer-moves.ts names them. */
const KEY_MOVES = { "move-up": "up", "move-down": "down", nest: "nest", outdent: "outdent" } as const satisfies Partial<Record<ActionOf<"layers">, KeyMove>>;
const isMove = (action: ActionOf<"layers">): action is keyof typeof KEY_MOVES => action in KEY_MOVES;
const rowUnder = (x: number, y: number): HTMLElement | null => document.elementFromPoint(x, y)?.closest<HTMLElement>("[role=treeitem]") ?? null;

export function LayersPanel({ doc, rows, selected, isContainer, onSelect, submit, insertion = null }: Props) {
  const tree = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  // Said, not only shown: what the last move or removal did, for a screen reader.
  const [said, setSaid] = useState("");
  // Refs, not state: a press that may become a drag, and "focus the tab stop once it has rendered". Nothing renders from them.
  const press = useRef<Press | null>(null);
  const focusNext = useRef(false);

  const shown = visibleRows(rows, collapsed);
  const shownIds = new Set(shown.map((row) => row.id));
  // The tab stop: the selected row, or the nearest shown row above it when it is folded away.
  let tabStop = selected;
  for (let guard = 0; !shownIds.has(tabStop) && guard < rows.length; guard++) tabStop = doc.nodes[tabStop]?.parentId ?? doc.rootId;
  const labelOf = (id: string): string => rows.find((row) => row.id === id)?.label ?? id;
  const hasChildren = (id: string): boolean => (doc.nodes[id]?.children.length ?? 0) > 0;

  // After a key moved the selection or removed a node, focus follows to the row that now holds the tab stop.
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    tree.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(tabStop)}"]`)?.focus();
  });

  const select = (id: string): void => { focusNext.current = true; onSelect(id); };
  const toggle = (id: string): void => { setCollapsed((was) => { const next = new Set(was); if (!next.delete(id)) next.add(id); return next; }); };
  /** One move_node, said as well as sent: a new parent is named, a new place among the same siblings is numbered.
   *  Said only if the replica took it: a refused move is the alert's to say, and the document did not change. */
  const move = (op: ReturnType<typeof dropToMoveOp>): void => {
    if (!op) return;
    // Worded BEFORE the submit: the replica applies the op to `doc` in place, so afterwards every move looks like a reorder.
    const sentence = `${labelOf(op.nodeId)} moved ${op.newParentId === doc.nodes[op.nodeId]?.parentId ? `to position ${String(op.index + 1)}` : `into ${labelOf(op.newParentId)}`}`;
    setSaid(submit(op) ? sentence : "");
  };

  // --- the pointer: press selects; a press that travels becomes a drag --------------------------
  const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>, id: string): void => {
    if (event.button !== 0) return;
    onSelect(id);
    if (id !== doc.rootId) press.current = { id, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLUListElement>): void => {
    const p = press.current;
    if (!p) return;
    if (!drag) {
      if (Math.hypot(event.clientX - p.x, event.clientY - p.y) < 4) return;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks: the drag still works while it stays over the tree */ }
    }
    const row = rowUnder(event.clientX, event.clientY);
    const targetId = row?.dataset["nodeId"];
    let over: Drag["over"] = null;
    if (row && targetId !== undefined) {
      const box = row.getBoundingClientRect();
      const placement = placementAt((event.clientY - box.top) / box.height, isContainer(targetId));
      const drop = { nodeId: p.id, targetId, placement };
      over = { ...drop, allowed: dropToMoveOp(doc, drop) !== null };
    }
    const next = { nodeId: p.id, over };
    setDrag((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  };
  const endDrag = (): void => { press.current = null; setDrag(null); };
  const onPointerUp = (): void => {
    if (drag?.over?.allowed) move(dropToMoveOp(doc, drag.over));
    endDrag();
  };

  // --- the keyboard (WAI-ARIA APG tree, plus Alt for moving and Delete); the keys are the registry's (shortcuts.ts) ---
  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset["nodeId"];
    const action = actionFor("layers", event);
    if (id === undefined || action === null) return;
    const at = shown.findIndex((row) => row.id === id);
    const node = doc.nodes[id];
    if (isMove(action)) {
      // What moves is what is selected: a row focused but not selected (Tab landed on it) becomes the selection as it goes.
      move(keyMoveOp(doc, id, KEY_MOVES[action]));
      select(id);
    } else if (action === "down") { const next = shown[at + 1]; if (next) select(next.id); }
    else if (action === "up") { const previous = shown[at - 1]; if (previous) select(previous.id); }
    else if (action === "right") {
      // Closed: open it. Open: into its first child. A leaf: nothing.
      if (hasChildren(id) && collapsed.has(id)) toggle(id);
      else if (hasChildren(id)) select(node?.children[0] ?? id);
    } else if (action === "left") {
      // Open: close it. Closed, or a leaf: up to the parent.
      if (hasChildren(id) && !collapsed.has(id)) toggle(id);
      else if (node?.parentId != null) select(node.parentId);
    } else if (action === "first") { const first = shown[0]; if (first) select(first.id); }
    else if (action === "last") { const last = shown.at(-1); if (last) select(last.id); }
    else if (action === "select") select(id);
    else if (action === "remove" && node?.parentId != null) {
      const sentence = `${labelOf(id)} removed`;
      setSaid(submit({ type: "remove_node", nodeId: id }) ? sentence : "");
      focusNext.current = true; // the selection falls back to the page (derived in Canvas.tsx); so does the focus
    } else if (action === "cancel" && drag) endDrag();
    else return;
    event.preventDefault();
  };

  return (
    <>
      <ul
        ref={tree}
        role="tree"
        aria-label="Layers"
        aria-describedby={hintId}
        className="tree"
        data-dragging={drag ? "" : undefined}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {shown.map((row) => {
          const node = doc.nodes[row.id];
          const siblings = node?.parentId == null ? [row.id] : (doc.nodes[node.parentId]?.children ?? []);
          const over = drag?.over?.targetId === row.id ? drag.over : insertion?.targetId === row.id ? insertion : null;
          return (
            <li
              key={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-setsize={siblings.length}
              aria-posinset={siblings.indexOf(row.id) + 1}
              aria-selected={row.id === selected}
              {...(hasChildren(row.id) ? { "aria-expanded": !collapsed.has(row.id) } : {})}
              tabIndex={row.id === tabStop ? 0 : -1}
              data-node-id={row.id}
              data-drop={over ? (over.allowed ? over.placement : "none") : undefined}
              data-dragging={drag?.nodeId === row.id ? "" : undefined}
              className="tree-row"
              style={{ "--depth": row.depth } as CSSProperties}
              onPointerDown={(event) => { onPointerDown(event, row.id); }}
            >
              {/* The disclosure is not a control of its own (a control inside a treeitem is nested-interactive): Left/Right are its keys; a click on it only folds. */}
              <span className="twisty" aria-hidden="true" onPointerDown={(event) => { event.stopPropagation(); }} onClick={() => { if (hasChildren(row.id)) toggle(row.id); }}>{hasChildren(row.id) ? (collapsed.has(row.id) ? "▸" : "▾") : ""}</span>
              <span className="tree-label">{row.label}</span>
            </li>
          );
        })}
      </ul>
      <p id={hintId} className="visually-hidden">Arrow keys move between layers; Right opens a layer or goes into it, Left closes it or goes to its parent. Alt with Up or Down reorders the layer, Alt with Right nests it into the layer above, Alt with Left moves it out. Delete removes it. Drag a layer to reorder it or to drop it into a container; drag a component from the library onto a layer to add it there.</p>
      <p aria-live="polite" className="visually-hidden">{said}</p>
    </>
  );
}
