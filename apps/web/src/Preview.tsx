import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { Preview as PreviewState } from "@noon/contracts";
import { openPreview, readPreview } from "./api.ts";
import { clampPreviewWidth, defaultPreviewWidth, DEVICES, frameScale, maxPreviewWidth, MIN_PREVIEW, type Device } from "./preview-split.ts";
import { actionFor } from "./shortcuts.ts";
import { percent, type Size } from "./viewport.ts";

/** This machine's loopback, or this canvas's own origin, whose dev server carries /preview/ (noon-l96). Never another site. */
const frameable = (url: string): boolean => new URL(url).hostname === "127.0.0.1" || new URL(url).origin === location.origin;
const live = (state: PreviewState | "busy" | undefined): boolean => state !== "busy" && (state?.status === "queued" || state?.status === "running");

/** An element's inner size, kept up to date by a ResizeObserver; {0, 0} until the first measure. */
function useMeasured<T extends HTMLElement>(): [RefObject<T | null>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => { setSize((was) => (was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight })); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);
  return [ref, size];
}

/**
 * The centre of the shell (E10.7): the canvas alone, or the canvas and the running page side by side with a
 * divider between them. The divider is a window splitter (APG): dragged by pointer, or moved with Left and
 * Right when focused (shortcuts.ts, scope "splitter"); its value is the preview's width in px, first half
 * the centre. The preview itself only mounts while open: an open preview holds a container (below).
 * ponytail: the width is a session's choice, not remembered; the narrow layout (app.css) stacks the two.
 */
export function PreviewSplit({ open, documentId, children }: { open: boolean; documentId: string; children: ReactNode }) {
  const [centre, size] = useMeasured<HTMLDivElement>();
  const [wanted, setWanted] = useState<number | null>(null);
  const width = size.width === 0 ? MIN_PREVIEW : wanted === null ? defaultPreviewWidth(size.width) : clampPreviewWidth(wanted, size.width);
  const resize = (to: number): void => { setWanted(clampPreviewWidth(to, size.width)); };
  // A ref, not state: the drag's origin changes nothing on the screen by itself.
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, width };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks: the drag still resizes, it just ends at the edge */ }
    event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => { const d = drag.current; if (d) resize(d.width - (event.clientX - d.x)); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const action = actionFor("splitter", event);
    if (action === "wider") resize(width + 24);
    else if (action === "narrower") resize(width - 24);
    else return;
    event.preventDefault();
  };
  return (
    <div ref={centre} className="split" data-preview={open ? "" : undefined} style={{ "--preview-width": `${String(width)}px` } as CSSProperties}>
      {children}
      {open && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Preview width"
            aria-valuenow={width}
            aria-valuemin={MIN_PREVIEW}
            aria-valuemax={maxPreviewWidth(size.width)}
            aria-valuetext={`${String(width)} pixels`}
            tabIndex={0}
            className="splitter"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onKeyDown={onKeyDown}
          />
          <Preview documentId={documentId} />
        </>
      )}
    </div>
  );
}

/**
 * The running page (F15): the document's own sandbox, in an iframe, inside a device frame (E10.7): phone,
 * tablet or desktop, each the device's CSS px wide so the page's own media queries answer to it, scaled to
 * fit the pane (preview-split.ts) and no larger than life.
 *
 * The URL is ASKED FOR once a second, never kept: a sandbox made anew (reaped, a new image) answers
 * under a new token (noon-9gz), and Vite's own self-heal cannot know that. No URL while the
 * job is live = the worker is (re)starting the container: "rebuilding". A preview that ended (nobody
 * was here for a minute, the worker restarted) is simply opened again.
 *
 * Opened on request (the top bar's Preview, or P), not with every canvas: a preview holds a container
 * (1 CPU, 1 GiB) for as long as it is open, and most visits to a document only edit it.
 *
 * `sandbox="allow-scripts"` and NOT allow-same-origin: every preview of the stack shares ONE origin (the
 * sandbox proxy's http://127.0.0.1:<port>, noon-9gz), so without an opaque origin one document's page
 * could read what another's left in storage, and fetch the other's source. Behind one public URL it is
 * this canvas's own origin (/preview/...), and there the opaque origin also keeps the page away from the canvas.
 * ponytail: polling. A pushed "the URL changed" (SSE) is the upgrade if a second of lag ever matters.
 */
function Preview({ documentId }: { documentId: string }) {
  const [state, setState] = useState<PreviewState | "busy">();
  const hadUrl = useRef(false);
  // The device is a session's choice; the first is the phone, the frame a page most needs checking in.
  const [device, setDevice] = useState<Device>(DEVICES[0] ?? { name: "Phone", width: 390, height: 844 });
  const [stage, pane] = useMeasured<HTMLDivElement>();
  const scale = frameScale(pane, device);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      let next: PreviewState | "busy" | undefined = await readPreview(documentId).catch(() => undefined); // a failed look is tried again in a second
      if (next && !live(next)) next = await openPreview(documentId).catch(() => next);
      if (stopped) return;
      if (next) setState(next);
      timer = setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [documentId]);

  const url = state === "busy" || !state?.url || !frameable(state.url) ? null : state.url;
  if (url) hadUrl.current = true;
  const words = url ? ""
    : state === "busy" ? "Your organisation already has as many previews open as it may. Close one, and this one starts."
    : !state || live(state) ? (hadUrl.current ? "Rebuilding the preview…" : "Starting the preview…")
    : "The preview could not start. Trying again…";
  return (
    <section aria-label="Preview" className="preview">
      <div className="preview-head">
        <div role="group" aria-label="Device" className="device-picker">
          {DEVICES.map((each) => (
            <button key={each.name} type="button" aria-pressed={each.name === device.name} onClick={() => { setDevice(each); }}>{each.name}</button>
          ))}
        </div>
        <span className="zoom-level"><span className="visually-hidden">Shown at </span>{percent(scale)}</span>
      </div>
      <div ref={stage} className="device-stage">
        {/* The fit box takes the SCALED size in the layout; the frame inside is the device's real size, scaled down by CSS alone. */}
        <div className="device-fit" style={{ width: device.width * scale, height: device.height * scale }}>
          <div className="device-frame" data-device={device.name.toLowerCase()} data-scale={scale.toFixed(3)} style={{ width: device.width, height: device.height, transform: `scale(${String(scale)})` }}>
            {/* keyed on the URL: a new address is a new page, an iframe whose src changes keeps nothing worth keeping */}
            {url && <iframe key={url} title="Preview of this page" src={url} sandbox="allow-scripts" />}
          </div>
        </div>
      </div>
      <p aria-live="polite" data-preview-status={state === "busy" ? "busy" : (state?.status ?? "")}>{words}</p>
    </section>
  );
}
