import { useEffect, useRef, useState } from "react";
import type { Preview as PreviewState } from "@noon/contracts";
import { openPreview, readPreview } from "./api.ts";

/** This machine's loopback, or this canvas's own origin, whose dev server carries /preview/ (noon-l96). Never another site. */
const frameable = (url: string): boolean => new URL(url).hostname === "127.0.0.1" || new URL(url).origin === location.origin;
const live = (state: PreviewState | "busy" | undefined): boolean => state !== "busy" && (state?.status === "queued" || state?.status === "running");

/**
 * The running page (F15): the document's own sandbox, in an iframe.
 *
 * The URL is ASKED FOR once a second, never kept: a sandbox made anew (reaped, a new image) answers
 * under a new token (noon-9gz), and Vite's own self-heal cannot know that. No URL while the
 * job is live = the worker is (re)starting the container: "rebuilding". A preview that ended (nobody
 * was here for a minute, the worker restarted) is simply opened again.
 *
 * Opened on request, not with every canvas: a preview holds a container (1 CPU, 1 GiB) for as long as
 * the document is open, and most visits to a document only edit it.
 *
 * `sandbox="allow-scripts"` and NOT allow-same-origin: every preview of the stack shares ONE origin (the
 * sandbox proxy's http://127.0.0.1:<port>, noon-9gz), so without an opaque origin one document's page
 * could read what another's left in storage, and fetch the other's source. Behind one public URL it is
 * this canvas's own origin (/preview/...), and there the opaque origin also keeps the page away from the canvas.
 * ponytail: polling. A pushed "the URL changed" (SSE) is the upgrade if a second of lag ever matters.
 */
export function Preview({ documentId }: { documentId: string }) {
  const [shown, setShown] = useState(false);
  const [state, setState] = useState<PreviewState | "busy">();
  const hadUrl = useRef(false);

  useEffect(() => {
    if (!shown) return;
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
  }, [documentId, shown]);

  if (!shown) return <section aria-label="Preview" className="preview"><button type="button" onClick={() => { setShown(true); }}>Show the running page</button></section>;

  const url = state === "busy" || !state?.url || !frameable(state.url) ? null : state.url;
  if (url) hadUrl.current = true;
  const words = url ? ""
    : state === "busy" ? "Your organisation already has as many previews open as it may. Close one, and this one starts."
    : !state || live(state) ? (hadUrl.current ? "Rebuilding the preview…" : "Starting the preview…")
    : "The preview could not start. Trying again…";
  return (
    <section aria-label="Preview" className="preview">
      {/* keyed on the URL: a new address is a new page, an iframe whose src changes keeps nothing worth keeping */}
      {url && <iframe key={url} title="Preview of this page" src={url} sandbox="allow-scripts" />}
      <p aria-live="polite" data-preview-status={state === "busy" ? "busy" : (state?.status ?? "")}>{words}</p>
    </section>
  );
}
