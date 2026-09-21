import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { describeDrift, DESIGN_SYSTEM_ENTRY, manifest } from "./index.ts";
import { extractManifest } from "./extract.ts";

// extractManifest builds a real TypeScript Program over the sample app: seconds, not milliseconds.
// Vitest's 5 s unit budget fits it alone and not under a loaded `make check`, which is a flaky test,
// which is a bug report. The assertions are untouched; only the clock they run against is honest now.
const COMPILER = 60_000;

test("the committed manifest matches the sample app's components (run `make manifest` if this fails)", () => {
  expect(describeDrift(manifest, extractManifest(DESIGN_SYSTEM_ENTRY))).toEqual([]);
}, COMPILER);

test("changing a component's props without regenerating is reported BY NAME (F14)", () => {
  // The mutation runs on a throwaway copy, so the working tree is never touched.
  const copy = mkdtempSync(join(tmpdir(), "noon-ds-"));
  try {
    cpSync(join(DESIGN_SYSTEM_ENTRY, ".."), copy, { recursive: true });
    const button = join(copy, "Button.tsx");
    writeFileSync(button, readFileSync(button, "utf8").replace('"primary" | "secondary" | "ghost"', '"primary" | "secondary" | "ghost" | "danger"'));
    const text = join(copy, "Text.tsx");
    writeFileSync(text, readFileSync(text, "utf8").replace("  value: string;", "  value: string;\n  italic?: boolean;"));

    const drift = describeDrift(manifest, extractManifest(join(copy, "index.ts")));
    expect(drift).toEqual([
      "Button: props changed (variant)",
      "Text: props changed (italic)",
    ]);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, COMPILER);

test("added and removed components are reported too", () => {
  const without = { ...manifest, components: manifest.components.filter((c) => c.name !== "Card") };
  expect(describeDrift(manifest, without)).toEqual(["Card: removed from the design system"]);
  expect(describeDrift(without, manifest)).toEqual(["Card: new in the design system"]);
});
