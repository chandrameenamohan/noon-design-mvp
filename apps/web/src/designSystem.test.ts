import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DESIGN_SYSTEM_ENTRY, manifest } from "@noon/design-system";
import { components, scopeTo, scopeToFrame, THUMB } from "./designSystem.ts";

// E10.2: the canvas renders the manifest's components, with the sample app's stylesheet kept to the frame.

test("every component the manifest names is one the canvas can render, and nothing else is", () => {
  expect(Object.keys(components).sort()).toEqual(manifest.components.map((c) => c.name).sort());
});

test("the page selectors become the frame's class; the component rules are untouched", () => {
  expect(scopeToFrame(":root { --a: 1; }\nbody { margin: 0; padding: 24px; }\n.ds-card { padding: 0; }")).toBe(".page-frame { --a: 1; }\n.page-frame { margin: 0; padding: 24px; }\n.ds-card { padding: 0; }");
  // Not fooled by names that merely contain the words.
  expect(scopeToFrame(".body { x: 1 } tbody { y: 2 } .ds-root { z: 3 }")).toBe(".body { x: 1 } tbody { y: 2 } .ds-root { z: 3 }");
  // The seed's real stylesheet (what Vite hands the page as ?raw; vitest stubs CSS imports, so it is read here).
  const scoped = scopeToFrame(readFileSync(new URL("tokens.css", `file://${DESIGN_SYSTEM_ENTRY}`), "utf8"));
  expect(scoped).not.toMatch(/(^|[}\s])(:root|body)\s*\{/u);
  expect(scoped).toContain(".page-frame {");
  expect(scoped).toContain(".ds-button");
  // The library's tiles (E10.5) get the same sheet under their own class, so a tile never wears the frame's geometry.
  expect(scopeTo(":root { --a: 1; } body { padding: 24px; }", THUMB)).toBe(`.${THUMB} { --a: 1; } .${THUMB} { padding: 24px; }`);
});
