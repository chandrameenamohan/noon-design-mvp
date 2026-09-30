import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { contrast } from "./colour.ts";
import { readPreference, resolveTheme, toggled } from "./theme.ts";

// unit:theme-preference (E10.1)

test("nothing remembered, or junk, follows the OS; a remembered theme wins over the OS", () => {
  expect(readPreference(null)).toBe("system");
  expect(readPreference(undefined)).toBe("system");
  expect(readPreference("blue")).toBe("system");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme(readPreference("light"), true)).toBe("light");
  expect(resolveTheme(readPreference("dark"), false)).toBe("dark");
});

test("the toggle remembers the opposite of what is SHOWN, so it holds when the OS changes its mind", () => {
  // OS dark, nothing chosen: shown dark; the toggle chooses light, and a later OS flip to light changes nothing.
  const chosen = toggled(resolveTheme("system", true));
  expect(chosen).toBe("light");
  expect(resolveTheme(chosen, false)).toBe("light");
  expect(toggled("light")).toBe("dark");
});

// --- The tokens themselves: contrast AA in both themes, recomputed from tokens.css ------------------
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
/** The custom properties declared in one selector block, as name -> #rrggbb. */
function tokensOf(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gu)].map((m) => [m[1] ?? "", m[2] ?? ""]));
}
const light = tokensOf(":root {");
// The dark block only overrides colours: what it does not name is inherited from the light block.
const dark = new Map([...light, ...tokensOf(':root[data-theme="dark"]')]);

// [text, on surface, minimum]: 4.5:1 for text, 3:1 for borders, focus rings and the canvas dots' frame.
const PAIRS: [string, string, number][] = [
  ["fg", "surface", 4.5], ["fg", "bg", 4.5], ["fg", "canvas", 4.5], ["fg", "surface-2", 4.5], ["fg", "accent-soft", 4.5],
  ["fg-muted", "surface", 4.5], ["fg-muted", "bg", 4.5], ["fg-muted", "canvas", 4.5],
  ["accent", "surface", 4.5], ["accent", "bg", 4.5], ["accent", "canvas", 4.5], ["on-accent", "accent", 4.5],
  ["danger-fg", "danger-bg", 4.5], ["warning-fg", "warning-bg", 4.5], ["info-fg", "info-bg", 4.5],
  ["border-strong", "surface", 3], ["border-strong", "canvas", 3], ["accent", "surface-2", 3],
  ["danger-border", "danger-bg", 3], ["warning-border", "warning-bg", 3], ["info-border", "info-bg", 3],
];

for (const [name, tokens] of [["light", light], ["dark", dark]] as const) {
  test(`${name} tokens: every text colour reads AA on the surface it sits on, borders and rings at 3:1`, () => {
    expect(tokens.size).toBeGreaterThan(20);
    for (const [text, on, minimum] of PAIRS) {
      const [a, b] = [tokens.get(text), tokens.get(on)];
      if (a === undefined || b === undefined) throw new Error(`${name} theme is missing --${text} or --${on}`);
      expect(contrast(a, b), `${name}: --${text} on --${on}`).toBeGreaterThanOrEqual(minimum);
    }
  });
}

test("the dark block redefines every COLOUR the light block declares (a colour left out would show light on dark)", () => {
  const darkOnly = tokensOf(':root[data-theme="dark"]');
  for (const name of light.keys()) expect(darkOnly.has(name), `--${name} has no dark value`).toBe(true);
});
