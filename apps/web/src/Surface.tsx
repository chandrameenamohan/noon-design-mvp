import { createElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Doc, DocNode, Presence } from "@noon/contracts";
import { ROOT_ID } from "@noon/doc-model";
import { colourOf } from "./colour.ts";
import { nameOf } from "./cursors.ts";
import { components, FRAME, frameStylesheet } from "./designSystem.ts";
import type { Hint } from "./Inspector.tsx";
import { indexAlong, insertLineAt, slotOnCanvas, type Axis, type Slot } from "./library-adds.ts";
import { hitTest, step, type Box, type Step } from "./selection.ts";
import { actionFor } from "./shortcuts.ts";
import { gapsBetween, paddingRing, type Rect, type Sides } from "./spaces.ts";
import { centreOn, fit, panBy, percent, toWorld, wheelZoom, zoomAt, zoomStep, type Point, type Viewport } from "./viewport.ts";

/**
 * The canvas (E10.2): the document's REAL components in a page frame on a dotted infinite sheet, with an
 * editor layer (selection, hover, the others' selections) over them.
 *
 * Two layers, one transform. The frame and the outlines both live in `.world`, which carries ONE
 * `translate() scale()` (viewport.ts); strokes and labels divide by `--zoom` in CSS, so they stay the
 * same size on the screen at every zoom and nothing is re-measured while zooming or panning.
 *
 * The frame is `inert`: the components render for real (a Button IS the sample app's Button) but take
 * no clicks, no focus and no screen-reader stop. The canvas itself is the one focusable thing; keys move
 * the selection (selection.ts), the Layers list beside it names every node as a button, and the
 * inspector's heading and a live sentence say what is selected.
 *
 * Nothing here writes to the document: the surface only reports a selection.
 *
 * `hint` (E10.4): a gap or padding control is hovered or focused in the inspector, and the space it stands
 * for is shaded here: the strips of computed padding inside the node's own box, or the spaces between its
 * children's boxes (spaces.ts). Measured like the outlines, in world coordinates, so it zooms with the frame.
 *
 * `insertion` (E10.5): a component is being carried from the library over the canvas, and the slot it would
 * take is shown: a box round the parent and a line where the new node lands among its children. The library
 * finds the slot with `slotUnder` below, the one place that reads the canvas's boxes for it.
 *
 * `cursors` (E10.6): the others' pointers, in WORLD coordinates, so they sit in `.world` like the outlines
 * and this window's zoom and pan move them by CSS alone; each divides by --zoom so the arrow and the tag
 * keep their screen size. The AI has no pointer: its mark is anchored to a NODE, and the same measuring pass
 * that finds the outlines' boxes finds where that node is. `reveal` pans the view so a node sits in the
 * middle (the top bar's avatars). The marks live in the editor layer, which is aria-hidden: who is here is
 * said in the top bar, not by decoration.
 */
type Props = {
  doc: Doc;
  labels: Map<string, string>;
  selected: string;
  /** Whether a node's component takes children: an empty one gets room on the canvas to be dropped into. */
  isContainer: (id: string) => boolean;
  /** The slot a carried component would take, or null while nothing is carried over the canvas. */
  insertion: Slot | null;
  /** The others' selections, node id -> who has it selected. */
  selectedBy: Map<string, Presence[]>;
  /** The space to shade, if a layout control is hovered or focused. */
  hint: Hint | null;
  onSelect: (id: string) => void;
  /** Where this person's pointer is, in world coordinates (SPEC F7, E10.6), or null when it left the canvas. */
  onPoint: (cursor: Presence["cursor"]) => void;
  /** The others' cursors: a person's at a world point, the AI's on a node. */
  cursors: readonly CursorMark[];
  /** A node to bring to the middle of the view; a new `nonce` each time, so the same node can be revealed twice. */
  reveal: Reveal | null;
};

/** Another's cursor on the sheet: `at` is a world point (a pointer) or a node (a peer without one, the AI). `idle`: still for a while, so it fades. */
export type CursorMark = { peerId: string; kind: Presence["actor"]["kind"]; label: string; colour: string; idle: boolean; at: Point | { nodeId: string } };
export type Reveal = { nodeId: string; nonce: number };

type Outline = { id: string; kind: "selected" | "hovered" | "peer" | "shade" | "insert" | "insert-line"; label: string; colour?: string; x: number; y: number; width: number; height: number };
type Drag = { kind: "pan" | "click"; x: number; y: number };

const propsText = (node: DocNode): string => Object.entries(node.props).map(([key, value]) => `${key}=${String(value)}`).join(" ");
const selectedByAttr = (others: Presence[]) => (others[0] ? { "data-selected-by": others.map((p) => p.name).join(", ") } : {});

/**
 * One node: the real component, its children rendered the same way INSIDE it, so the design system
 * lays them out exactly as the running page would. The wrapper is `display: contents`: it names the
 * node for the editor (data-node-id, data-component, data-depth) and takes no box of its own, so a
 * Stack's flex items are the components themselves. `.node-props` is the node's props as text, for the
 * tests' eyes (the e2e suites read it); the frame is inert, so nobody else meets it. An EMPTY container
 * (`data-empty-container`) is given a little height by the CSS: the running page would show nothing there,
 * but a person has to be able to click it and drop into it (E10.5).
 * ponytail: every node re-rendered on every change (documents are at most 64 deep and small); memo per
 * node, keyed on the node object, is the upgrade when a big document lags.
 */
function NodeView({ doc, node, depth, selectedBy, isContainer }: { doc: Doc; node: DocNode; depth: number; selectedBy: Map<string, Presence[]>; isContainer: (id: string) => boolean }) {
  const Component = components[node.component];
  const children = node.children.flatMap((id) => { const child = doc.nodes[id]; return child ? [<NodeView key={id} doc={doc} node={child} depth={depth + 1} selectedBy={selectedBy} isContainer={isContainer} />] : []; });
  return (
    <div data-node-id={node.id} data-component={node.component} data-depth={depth} data-empty-container={children.length === 0 && isContainer(node.id) ? "" : undefined} className="node" {...selectedByAttr(selectedBy.get(node.id) ?? [])}>
      {Component ? createElement(Component, node.props, children) : <div className="unknown-component">{node.component}</div>}
      <span className="node-props">{propsText(node)}</span>
    </div>
  );
}

/** A wrapper's own element: the component's (the wrapper has no box), the frame itself for the page. */
const ownOf = (wrapper: Element): Element | null => (wrapper.getAttribute("data-node-id") === ROOT_ID ? wrapper : wrapper.firstElementChild);
/** A wrapper's box on the screen. */
const rectOf = (wrapper: Element): DOMRect | undefined => ownOf(wrapper)?.getBoundingClientRect();
const boxesOf = (view: HTMLElement): Box[] =>
  [...view.querySelectorAll("[data-node-id]")].flatMap((wrapper) => {
    const rect = rectOf(wrapper);
    return rect ? [{ id: wrapper.getAttribute("data-node-id") ?? "", depth: Number(wrapper.getAttribute("data-depth")), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }] : [];
  });
/** The node's own children on the canvas: the wrappers whose nearest wrapper ancestor is this one (the real component sits in between). */
const childWrappers = (wrapper: Element): Element[] => [...wrapper.querySelectorAll("[data-node-id]")].filter((child) => child.parentElement?.closest("[data-node-id]") === wrapper);
const asRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const childRects = (wrapper: Element): Rect[] => childWrappers(wrapper).flatMap((child) => { const r = rectOf(child); return r ? [asRect(r)] : []; });
/** The padding the design system actually applied: in the element's own px (before the world's scale) times `zoom` (after it). */
function paddingOf(own: Element, zoom: number): Sides {
  const style = getComputedStyle(own);
  const px = (value: string): number => (Number.parseFloat(value) || 0) * zoom;
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}
/** Which way a container lays its children out: a flex row along x, everything else (a column, block flow) along y. */
const axisOf = (own: Element): Axis => { const style = getComputedStyle(own); return style.display.includes("flex") && style.flexDirection.startsWith("row") ? "x" : "y"; };
/** The content box: the box less its padding. */
const innerOf = (rect: Rect, padding: Sides): Rect => ({ left: rect.left + padding.left, top: rect.top + padding.top, right: rect.right - padding.right, bottom: rect.bottom - padding.bottom });
const wrapperIn = (view: HTMLElement, id: string): Element | null => view.querySelector(`[data-node-id="${CSS.escape(id)}"]`);

/**
 * The slot a component dropped at `point` (screen px) on the canvas would take (E10.5): the node under the
 * pointer, and, for a container, the index the pointer has reached among its children along its layout
 * axis. The library calls this on every pointer move while a component is carried over the canvas.
 */
export function slotUnder(view: HTMLElement, point: Point, doc: Doc, isContainer: (id: string) => boolean): Slot | null {
  return slotOnCanvas(doc, hitTest(boxesOf(view), point), isContainer, (id) => {
    const wrapper = wrapperIn(view, id);
    const own = wrapper ? ownOf(wrapper) : null;
    if (!wrapper || !own) return 0;
    const axis = axisOf(own);
    return indexAlong(childRects(wrapper).map((r) => (axis === "x" ? { start: r.left, end: r.right } : { start: r.top, end: r.bottom })), axis === "x" ? point.x : point.y);
  });
}

/**
 * The rectangles a hint shades, on the SCREEN. Padding is read from the component's computed style: what the
 * design system actually applied, whether from the prop or its own default. Both are in CSS px; the caller
 * takes them to world coordinates.
 */
function shadesOf(wrapper: Element, space: Hint["space"], zoom: number): Rect[] {
  if (space === "gap") return gapsBetween(childRects(wrapper));
  const own = ownOf(wrapper);
  const rect = rectOf(wrapper);
  return own && rect ? paddingRing(asRect(rect), paddingOf(own, zoom)) : [];
}
/** The drop indicator's two rectangles, on the SCREEN: the parent's box, and the line where the new node lands. */
function insertionRects(wrapper: Element, index: number, zoom: number): { box: Rect; line: Rect } | null {
  const own = ownOf(wrapper);
  const rect = rectOf(wrapper);
  if (!own || !rect) return null;
  const box = asRect(rect);
  return { box, line: insertLineAt(innerOf(box, paddingOf(own, zoom)), childRects(wrapper), axisOf(own), index) };
}
const hundredths = (n: number): number => Math.round(n * 100) / 100;
const isAnchored = (at: CursorMark["at"]): at is { nodeId: string } => "nodeId" in at;

/**
 * One cursor. The arrow's tip is the element's top-left corner, the point itself; the tag hangs off it. The AI
 * has no pointer, so its mark is a spark set a little inside the node's corner, where a pointer would not be.
 */
function CursorView({ mark, at }: { mark: CursorMark; at: Point }) {
  return (
    <div data-presence-cursor data-actor-kind={mark.kind} data-idle={mark.idle ? "" : undefined} {...(isAnchored(mark.at) ? { "data-node": mark.at.nodeId } : {})} className="presence-cursor" style={{ left: at.x, top: at.y, "--peer-colour": mark.colour } as CSSProperties}>
      <svg className="cursor-glyph" viewBox="0 0 16 16" width="16" height="16">
        {mark.kind === "agent" ? <path d="M8 0.5 L10 6 L15.5 8 L10 10 L8 15.5 L6 10 L0.5 8 L6 6 Z" /> : <path d="M0.5 0.5 L15 7 L8.5 8.5 L6.5 15.5 Z" />}
      </svg>
      <span className="cursor-tag">{mark.label}</span>
    </div>
  );
}

export function Surface({ doc, labels, selected, selectedBy, hint, isContainer, insertion, onSelect, onPoint, cursors, reveal }: Props) {
  const view = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [outlines, setOutlines] = useState<Outline[]>([]);
  // Where the node-anchored cursors sit (node id -> world point), measured with the outlines.
  const [anchored, setAnchored] = useState<Record<string, Point>>({});
  // The last reveal answered: the effect below runs every render, and must pan once per request.
  const revealed = useRef<number | null>(null);
  // Space held: the next drag pans instead of selecting. Panning: a pan drag is under way.
  const [panMode, setPanMode] = useState(false);
  const [panning, setPanning] = useState(false);
  // A ref, not state: the drag's last point changes with every pointer event and nothing renders from it.
  const drag = useRef<Drag | null>(null);
  const root = doc.nodes[doc.rootId];

  const fitted = (): Viewport => {
    const v = view.current;
    const f = frame.current;
    return v && f ? fit({ width: v.clientWidth, height: v.clientHeight }, { width: f.offsetWidth, height: f.offsetHeight }) : { x: 0, y: 0, zoom: 1 };
  };
  const centre = () => ({ x: (view.current?.clientWidth ?? 0) / 2, y: (view.current?.clientHeight ?? 0) / 2 });
  const zoomBy = (direction: 1 | -1): void => { const at = centre(); setViewport((v) => zoomAt(v, zoomStep(v.zoom, direction), at)); };

  // The first sight of a document is the whole page, centred.
  useLayoutEffect(() => { setViewport(fitted()); }, []);

  // A native listener, not onWheel: it must preventDefault (ctrl+wheel is otherwise the browser's own
  // zoom, plain wheel the pane's scroll), and React does not promise a non-passive wheel listener.
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const box = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) setViewport((v) => zoomAt(v, wheelZoom(v.zoom, event.deltaY), { x: event.clientX - box.left, y: event.clientY - box.top }));
      else setViewport((v) => panBy(v, -event.deltaX, -event.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); };
  }, []);

  // On the canvas `data-component` names a NODE (the tests count nodes by it); the sample app's components
  // also stamp it on their own root element, which would double every count. Taken off after each render:
  // React never rewrites a prop that did not change, so it stays off until a remount, which lands here again.
  useLayoutEffect(() => { frame.current?.querySelectorAll("[data-component]:not([data-node-id])").forEach((el) => { el.removeAttribute("data-component"); }); });

  // The outlines follow the components' real boxes, measured after every render and kept in WORLD
  // coordinates, so zooming and panning move them by CSS alone. Set only when something moved: a
  // measure that finds the same boxes must not render again.
  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const wanted: Pick<Outline, "id" | "kind" | "label" | "colour">[] = [
      { id: selected, kind: "selected", label: labels.get(selected) ?? "" },
      ...(hovered !== null && hovered !== selected ? [{ id: hovered, kind: "hovered" as const, label: labels.get(hovered) ?? "" }] : []),
      ...[...selectedBy].flatMap(([id, peers]) => peers.map((p) => ({ id, kind: "peer" as const, label: nameOf(p), colour: colourOf(p.peerId) }))),
    ];
    const toOutline = (w: Pick<Outline, "id" | "kind" | "label" | "colour">, rect: Rect): Outline => {
      const at = toWorld(viewport, { x: rect.left - box.left, y: rect.top - box.top });
      return { ...w, x: hundredths(at.x), y: hundredths(at.y), width: hundredths((rect.right - rect.left) / viewport.zoom), height: hundredths((rect.bottom - rect.top) / viewport.zoom) };
    };
    const wrapperOf = (id: string): Element | null => wrapperIn(el, id);
    const next = wanted.flatMap((w) => {
      const wrapper = wrapperOf(w.id);
      const rect = wrapper ? rectOf(wrapper) : undefined;
      return rect ? [toOutline(w, asRect(rect))] : [];
    });
    const shaded = hint ? wrapperOf(hint.nodeId) : null;
    if (hint && shaded) next.push(...shadesOf(shaded, hint.space, viewport.zoom).map((rect) => toOutline({ id: hint.nodeId, kind: "shade", label: "" }, rect)));
    const into = insertion ? wrapperOf(insertion.parentId) : null;
    const rects = insertion && into ? insertionRects(into, insertion.index, viewport.zoom) : null;
    if (insertion && rects) next.push(toOutline({ id: insertion.parentId, kind: "insert", label: labels.get(insertion.parentId) ?? "" }, rects.box), toOutline({ id: insertion.parentId, kind: "insert-line", label: "" }, rects.line));
    setOutlines((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    // The node-anchored cursors (the AI): the top-left corner of the node's box, in world coordinates.
    const seats: Record<string, Point> = {};
    for (const mark of cursors) {
      if (!isAnchored(mark.at)) continue;
      const wrapper = wrapperOf(mark.at.nodeId);
      const rect = wrapper ? rectOf(wrapper) : undefined;
      if (rect) { const at = toWorld(viewport, { x: rect.left - box.left, y: rect.top - box.top }); seats[mark.at.nodeId] = { x: hundredths(at.x), y: hundredths(at.y) }; }
    }
    setAnchored((current) => (JSON.stringify(current) === JSON.stringify(seats) ? current : seats));
  });

  // An avatar was pressed (E10.6): the view pans so that person's selection sits in the middle, at this zoom.
  useLayoutEffect(() => {
    const el = view.current;
    if (!reveal || reveal.nonce === revealed.current || !el) return;
    revealed.current = reveal.nonce;
    const wrapper = wrapperIn(el, reveal.nodeId);
    const rect = wrapper ? rectOf(wrapper) : undefined;
    if (!rect) return;
    const box = el.getBoundingClientRect();
    setViewport(centreOn(viewport, { width: el.clientWidth, height: el.clientHeight }, toWorld(viewport, { x: (rect.left + rect.right) / 2 - box.left, y: (rect.top + rect.bottom) / 2 - box.top })));
  });

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button === 1 || (event.button === 0 && panMode)) {
      drag.current = { kind: "pan", x: event.clientX, y: event.clientY };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks: the drag still pans, it just ends at the edge */ }
      setPanning(true);
      event.preventDefault(); // the middle button's autoscroll
    } else if (event.button === 0) {
      drag.current = { kind: "click", x: event.clientX, y: event.clientY };
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (d?.kind === "pan") {
      setViewport((v) => panBy(v, event.clientX - d.x, event.clientY - d.y));
      d.x = event.clientX;
      d.y = event.clientY;
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    // In WORLD coordinates, not screen pixels or a fraction of the canvas: the other window has its own size, zoom
    // and pan, and this way the pointer lands on the same component there. Hundredths: a sub-pixel is noise on the wire.
    const at = toWorld(viewport, { x: event.clientX - box.left, y: event.clientY - box.top });
    onPoint({ x: hundredths(at.x), y: hundredths(at.y) });
    setHovered(hitTest(boxesOf(event.currentTarget), { x: event.clientX, y: event.clientY }));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "pan") { setPanning(false); return; }
    // A click, not the start of a drag that changed its mind: the node under the pointer, or the page.
    if (Math.hypot(event.clientX - d.x, event.clientY - d.y) < 4) onSelect(hitTest(boxesOf(event.currentTarget), { x: event.clientX, y: event.clientY }) ?? ROOT_ID);
  };
  const onPointerLeave = (): void => { onPoint(null); setHovered(null); };

  // The keys are the registry's (shortcuts.ts, scope "canvas"); a key that is no action here bubbles on (P, ?).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    const action = actionFor("canvas", event);
    if (action === null) return;
    switch (action) {
      case "next": case "previous": case "in": case "out": onSelect(step(doc, selected, action satisfies Step)); break;
      case "page": onSelect(ROOT_ID); break;
      case "zoom-in": zoomBy(1); break;
      case "zoom-out": zoomBy(-1); break;
      case "fit": setViewport(fitted()); break;
      case "pan": setPanMode(true); break;
    }
    event.preventDefault();
  };

  if (!root) return null;
  return (
    <div className="stage">
      <section
        ref={view}
        aria-label="Canvas"
        aria-describedby={hintId}
        tabIndex={0}
        className="canvas"
        data-panning={panning ? "dragging" : panMode ? "ready" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null; setPanning(false); }}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => { if (event.key === " ") setPanMode(false); }}
        onBlur={() => { setPanMode(false); }}
      >
        <style>{frameStylesheet}</style>
        <div className="world" data-zoom={viewport.zoom.toFixed(2)} style={{ transform: `translate(${String(viewport.x)}px, ${String(viewport.y)}px) scale(${String(viewport.zoom)})`, "--zoom": viewport.zoom } as CSSProperties}>
          <div ref={frame} className={FRAME} inert data-node-id={root.id} data-component={root.component} data-depth={0} {...selectedByAttr(selectedBy.get(root.id) ?? [])}>
            {root.children.flatMap((id) => { const child = doc.nodes[id]; return child ? [<NodeView key={id} doc={doc} node={child} depth={1} selectedBy={selectedBy} isContainer={isContainer} />] : []; })}
            <span className="node-props">{propsText(root)}</span>
          </div>
          <div className="editor-layer" aria-hidden="true">
            {outlines.map((o, i) => (
              <div key={`${o.kind}:${o.id}:${o.label}:${String(i)}`} className={`outline outline-${o.kind}`} data-outline={o.kind} style={{ left: o.x, top: o.y, width: o.width, height: o.height, ...(o.colour === undefined ? {} : { "--peer-colour": o.colour }) }}>
                {o.label !== "" && <span className="outline-label">{o.label}</span>}
              </div>
            ))}
            {cursors.map((mark) => {
              const at = isAnchored(mark.at) ? anchored[mark.at.nodeId] : mark.at;
              return at ? <CursorView key={mark.peerId} mark={mark} at={at} /> : null;
            })}
          </div>
        </div>
        <p id={hintId} className="visually-hidden">Arrow keys move between neighbouring elements, Enter goes into an element, Shift and Enter goes to its parent, Escape selects the page. Plus and minus zoom, 0 fits the page. Hold Space and drag to pan.</p>
        <p aria-live="polite" className="visually-hidden">{labels.get(selected) ?? "Page"} selected</p>
      </section>
      <div className="zoom-bar" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" onClick={() => { zoomBy(-1); }}>−</button>
        <span className="zoom-level" aria-live="polite">{percent(viewport.zoom)}</span>
        <button type="button" aria-label="Zoom in" onClick={() => { zoomBy(1); }}>+</button>
        <button type="button" onClick={() => { setViewport(fitted()); }}>Fit</button>
      </div>
    </div>
  );
}
