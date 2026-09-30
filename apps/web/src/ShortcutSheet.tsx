import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef } from "react";
import { actionFor, describeKeys, SCOPES, shortcutsIn } from "./shortcuts.ts";

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * Tab and Shift+Tab walk the sheet's own controls and go round. A modal <dialog> makes the page behind inert,
 * but Chromium lets Tab from the last control leave the DOCUMENT (to the browser's toolbar), so focus is out of
 * the sheet until the person tabs all the way back: the trap is ours.
 */
function cycle(event: ReactKeyboardEvent<HTMLDialogElement>): void {
  if (actionFor("sheet", event) !== "cycle") return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const at = controls.indexOf(document.activeElement as HTMLElement);
  const next = controls.at(event.shiftKey ? (at <= 0 ? -1 : at - 1) : (at + 1) % controls.length);
  event.preventDefault();
  next?.focus();
}

/**
 * The `?` sheet (E10.7): every shortcut the editor answers, read from the one registry (shortcuts.ts), by
 * scope. A native <dialog> shown modally: the browser moves focus into it, makes the rest of the page inert,
 * closes it on Escape and gives focus back to where it was; only Tab's wrap at the ends is ours (cycle). `open` is the
 * caller's state; the element is told to match it, and its close event (Escape, the button) tells the caller.
 */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  return (
    // A click on the dialog element itself is a click on the backdrop (the body fills it): it closes, as Escape does.
    <dialog ref={dialog} className="sheet" aria-labelledby={titleId} onClose={onClose} onKeyDown={cycle} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-columns">
          {SCOPES.map((scope) => (
            <section key={scope.id} className="sheet-scope" aria-labelledby={`${titleId}-${scope.id}`}>
              <h3 id={`${titleId}-${scope.id}`}>{scope.title}</h3>
              <dl>
                {shortcutsIn(scope.id).map((s) => (
                  <div key={s.action}>
                    <dt><kbd>{describeKeys(s)}</kbd></dt>
                    <dd>{s.does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}
