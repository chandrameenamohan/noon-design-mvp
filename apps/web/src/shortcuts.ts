/**
 * The keyboard, in ONE place (E10.7). Every key the editor answers is declared here, and this table
 * drives two things: the handlers (Surface, LayersPanel, LibraryPanel, Inspector, the split and the global
 * listener in Canvas ask `actionFor` which of THEIR actions a keydown is, and never compare `event.key`
 * themselves) and the `?` sheet (ShortcutSheet.tsx lists it). So a key the sheet promises is a key that
 * works, and two shortcuts on one key in one scope fail a test (shortcuts.test.ts) instead of surprising.
 *
 * A scope is WHERE a key works: the focused widget (canvas, layers, ...) or everywhere the person is not
 * typing (global). Ctrl and Cmd are never bound: those chords are the browser's. `keys` are KeyboardEvent.key
 * values; `alt` false unless said; `shift` unsaid = either way (Enter and Shift+Enter on the canvas differ,
 * so both say).
 * ponytail: fixed bindings. Rebinding (out of scope) would be a per-browser override table layered onto this one.
 */
export type Scope = "global" | "canvas" | "layers" | "library" | "search" | "inspector" | "splitter" | "sheet";
export type Shortcut = { scope: Scope; action: string; keys: readonly string[]; alt?: boolean; shift?: boolean; does: string };

export const SHORTCUTS = [
  { scope: "global", action: "help", keys: ["?"], does: "Show this sheet" },
  { scope: "global", action: "preview", keys: ["p", "P"], does: "Show or hide the running page beside the canvas" },

  { scope: "canvas", action: "next", keys: ["ArrowRight", "ArrowDown"], does: "Select the next element" },
  { scope: "canvas", action: "previous", keys: ["ArrowLeft", "ArrowUp"], does: "Select the previous element" },
  { scope: "canvas", action: "in", keys: ["Enter"], shift: false, does: "Go into the element, to its first child" },
  { scope: "canvas", action: "out", keys: ["Enter"], shift: true, does: "Go to the element's parent" },
  { scope: "canvas", action: "page", keys: ["Escape"], does: "Select the page" },
  { scope: "canvas", action: "zoom-in", keys: ["+", "="], does: "Zoom in" },
  { scope: "canvas", action: "zoom-out", keys: ["-", "_"], does: "Zoom out" },
  { scope: "canvas", action: "fit", keys: ["0"], does: "Fit the page in the view" },
  { scope: "canvas", action: "pan", keys: [" "], does: "Hold, and drag to pan" },

  { scope: "layers", action: "down", keys: ["ArrowDown"], does: "Select the next layer" },
  { scope: "layers", action: "up", keys: ["ArrowUp"], does: "Select the previous layer" },
  { scope: "layers", action: "right", keys: ["ArrowRight"], does: "Open the layer, or go into it" },
  { scope: "layers", action: "left", keys: ["ArrowLeft"], does: "Close the layer, or go to its parent" },
  { scope: "layers", action: "first", keys: ["Home"], does: "Select the first layer" },
  { scope: "layers", action: "last", keys: ["End"], does: "Select the last layer" },
  { scope: "layers", action: "select", keys: [" ", "Enter"], does: "Select the focused layer" },
  { scope: "layers", action: "remove", keys: ["Delete", "Backspace"], does: "Remove the layer" },
  { scope: "layers", action: "move-up", keys: ["ArrowUp"], alt: true, does: "Move the layer up" },
  { scope: "layers", action: "move-down", keys: ["ArrowDown"], alt: true, does: "Move the layer down" },
  { scope: "layers", action: "nest", keys: ["ArrowRight"], alt: true, does: "Nest the layer into the one above" },
  { scope: "layers", action: "outdent", keys: ["ArrowLeft"], alt: true, does: "Move the layer out of its container" },
  { scope: "layers", action: "cancel", keys: ["Escape"], does: "Cancel a drag" },

  { scope: "library", action: "next", keys: ["ArrowDown", "ArrowRight"], does: "Move to the next component" },
  { scope: "library", action: "previous", keys: ["ArrowUp", "ArrowLeft"], does: "Move to the previous component" },
  { scope: "library", action: "first", keys: ["Home"], does: "Move to the first component" },
  { scope: "library", action: "last", keys: ["End"], does: "Move to the last component" },
  { scope: "library", action: "add", keys: ["Enter", " "], does: "Add the component into the selection, or after it" },
  { scope: "library", action: "cancel", keys: ["Escape"], does: "Cancel a drag" },

  { scope: "search", action: "list", keys: ["ArrowDown"], does: "Move from the search box to the components" },

  { scope: "inspector", action: "commit", keys: ["Enter"], does: "Apply the typed value" },
  { scope: "inspector", action: "step", keys: ["ArrowUp", "ArrowDown"], does: "Step a number by one, with Shift by ten" },

  { scope: "splitter", action: "wider", keys: ["ArrowLeft"], does: "Widen the preview" },
  { scope: "splitter", action: "narrower", keys: ["ArrowRight"], does: "Narrow the preview" },

  { scope: "sheet", action: "close", keys: ["Escape"], does: "Close this sheet" },
  { scope: "sheet", action: "cycle", keys: ["Tab"], does: "Move among this sheet's controls, round from the last to the first" },
] as const satisfies readonly Shortcut[];

/** The scopes as the sheet shows them, in reading order, each with its title. */
export const SCOPES: readonly { id: Scope; title: string }[] = [
  { id: "global", title: "Everywhere" },
  { id: "canvas", title: "Canvas" },
  { id: "layers", title: "Layers" },
  { id: "library", title: "Library" },
  { id: "search", title: "Library search" },
  { id: "inspector", title: "Inspector" },
  { id: "splitter", title: "Preview divider" },
  { id: "sheet", title: "This sheet" },
];

type Entry = (typeof SHORTCUTS)[number];
type Actions = { [S in Scope]: Extract<Entry, { scope: S }>["action"] };
/** The actions one scope declares, as a type: a handler's switch is checked against the table. */
export type ActionOf<S extends Scope> = Actions[S];
/** What `actionFor` reads of a keydown: a React or a native KeyboardEvent, or a plain object in a test. */
export type KeyLike = Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">;

const binds = (s: Shortcut, event: KeyLike): boolean => s.keys.includes(event.key) && (s.alt ?? false) === event.altKey && (s.shift === undefined || s.shift === event.shiftKey);

/** The action a keydown means in `scope`, or null: not a shortcut here, or a browser chord (Ctrl, Cmd). */
export function actionFor<S extends Scope>(scope: S, event: KeyLike): ActionOf<S> | null {
  if (event.ctrlKey || event.metaKey) return null;
  // The scope was checked, so the action is one of that scope's: the type only knows it once told.
  const found = SHORTCUTS.find((s) => s.scope === scope && binds(s, event));
  return (found?.action ?? null) as ActionOf<S> | null;
}

/** The shortcuts of one scope, for the sheet. */
export const shortcutsIn = (scope: Scope): readonly Shortcut[] => SHORTCUTS.filter((s) => s.scope === scope);

/**
 * A keydown that is TYPING: in a field, a select or anything editable, every key is the field's. The global
 * shortcuts (a bare `?`, `p`) stay out of the way, so a `?` typed into the library's search box is a `?`.
 */
export const typingIn = (target: { tagName: string; isContentEditable: boolean }): boolean => ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;

const GLYPHS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", " ": "Space", "-": "−" };
/** The keys a shortcut answers, as a person reads them: "Alt + ↑", "Shift + Enter", "→ / ↓", "P". */
export function describeKeys(s: Shortcut): string {
  const names = [...new Set(s.keys.map((key) => GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key)))];
  return [...(s.alt === true ? ["Alt"] : []), ...(s.shift === true ? ["Shift"] : []), names.join(" / ")].join(" + ");
}
