import { expect, test } from "vitest";
import { actionFor, describeKeys, SCOPES, SHORTCUTS, shortcutsIn, typingIn, type Shortcut } from "./shortcuts.ts";

// unit:shortcut-registry-no-collisions (E10.7)

const press = (key: string, mods: Partial<Pick<KeyboardEvent, "altKey" | "shiftKey" | "ctrlKey" | "metaKey">> = {}) => ({ key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

/** Two shortcuts collide when one keydown could mean both: same key and Alt, Shift not told apart, in one scope or with a global one. */
const collide = (a: Shortcut, b: Shortcut): boolean =>
  (a.scope === b.scope || a.scope === "global" || b.scope === "global") &&
  a.keys.some((key) => b.keys.includes(key)) &&
  (a.alt ?? false) === (b.alt ?? false) &&
  (a.shift === undefined || b.shift === undefined || a.shift === b.shift);

test("no two shortcuts answer the same keydown: none within a scope, and a global one nowhere", () => {
  const collisions: string[] = [];
  for (const [i, a] of SHORTCUTS.entries()) for (const b of SHORTCUTS.slice(i + 1)) if (collide(a, b)) collisions.push(`${a.scope}/${a.action} vs ${b.scope}/${b.action}`);
  expect(collisions).toEqual([]);
});

test("every shortcut is whole (a scope the sheet shows, an action, keys, a sentence), and actions are unique per scope", () => {
  const shown = new Set(SCOPES.map((s) => s.id));
  for (const s of SHORTCUTS) {
    expect(shown.has(s.scope), `${s.scope} has a title`).toBe(true);
    expect(s.keys.length).toBeGreaterThan(0);
    expect(s.action).not.toBe("");
    expect(s.does).not.toBe("");
  }
  const names = SHORTCUTS.map((s) => `${s.scope}/${s.action}`);
  expect(new Set(names).size).toBe(names.length);
  // ...and every scope the sheet shows has something to show.
  for (const scope of SCOPES) expect(shortcutsIn(scope.id).length, scope.title).toBeGreaterThan(0);
});

test("actionFor reads a keydown as its scope does: Alt and Shift tell shortcuts apart, Ctrl and Cmd are the browser's", () => {
  expect(actionFor("canvas", press("ArrowRight"))).toBe("next");
  expect(actionFor("canvas", press("Enter"))).toBe("in");
  expect(actionFor("canvas", press("Enter", { shiftKey: true }))).toBe("out");
  expect(actionFor("canvas", press("="))).toBe("zoom-in");
  expect(actionFor("canvas", press("ArrowRight", { altKey: true }))).toBeNull();
  expect(actionFor("layers", press("ArrowUp"))).toBe("up");
  expect(actionFor("layers", press("ArrowUp", { altKey: true }))).toBe("move-up");
  expect(actionFor("layers", press("ArrowUp", { shiftKey: true }))).toBe("up"); // Shift not told apart here
  expect(actionFor("library", press(" "))).toBe("add");
  expect(actionFor("global", press("?", { shiftKey: true }))).toBe("help");
  expect(actionFor("global", press("P", { shiftKey: true }))).toBe("preview");
  expect(actionFor("global", press("p"))).toBe("preview");
  expect(actionFor("global", press("p", { ctrlKey: true }))).toBeNull();
  expect(actionFor("canvas", press("0", { metaKey: true }))).toBeNull();
  expect(actionFor("canvas", press("q"))).toBeNull();
  expect(actionFor("sheet", press("Escape"))).toBe("close");
  expect(actionFor("sheet", press("Tab"))).toBe("cycle");
  expect(actionFor("sheet", press("Tab", { shiftKey: true }))).toBe("cycle"); // backwards round, too
});

test("typing in a field, a select or an editable region is never a shortcut", () => {
  expect(typingIn({ tagName: "INPUT", isContentEditable: false })).toBe(true);
  expect(typingIn({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
  expect(typingIn({ tagName: "SELECT", isContentEditable: false })).toBe(true);
  expect(typingIn({ tagName: "DIV", isContentEditable: true })).toBe(true);
  expect(typingIn({ tagName: "SECTION", isContentEditable: false })).toBe(false);
  expect(typingIn({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
});

test("the sheet's key names: modifiers first, arrows as glyphs, Space by name, one letter for both cases", () => {
  const of = (scope: Shortcut["scope"], action: string): Shortcut => { const found = SHORTCUTS.find((s) => s.scope === scope && s.action === action); if (!found) throw new Error(action); return found; };
  expect(describeKeys(of("layers", "move-up"))).toBe("Alt + ↑");
  expect(describeKeys(of("canvas", "out"))).toBe("Shift + Enter");
  expect(describeKeys(of("canvas", "next"))).toBe("→ / ↓");
  expect(describeKeys(of("canvas", "pan"))).toBe("Space");
  expect(describeKeys(of("canvas", "zoom-out"))).toBe("− / _");
  expect(describeKeys(of("global", "preview"))).toBe("P");
  expect(describeKeys(of("global", "help"))).toBe("?");
});
