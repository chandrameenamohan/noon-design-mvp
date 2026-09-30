import type { ComponentType } from "react";
// The sample app's REAL components, straight from the seed (owner decision 2026-09-30): they are the
// repo's own static code, the same files DESIGN_SYSTEM_ENTRY (@noon/design-system) names, not fetched
// from Gitea at runtime. A plain relative import, not a Vite alias: tsc and knip read this, an alias
// would need a second copy of the path in tsconfig; switching design systems is still this one line.
// ponytail: a customer's design system would render in a sandboxed iframe, never in the editor's origin.
import { Button, Card, Image, Input, Stack, Text } from "../../../seed/sample-app/src/design-system/index.ts";
import stylesheet from "../../../seed/sample-app/src/design-system/tokens.css?raw";

/** The frame's class: the design system's own tokens and page rules apply inside it and nowhere else. */
export const FRAME = "page-frame";

/**
 * By manifest name. The doc's props were checked against the manifest by the replica before they got
 * here, so a node's props ARE the component's props; the cast says so to the compiler.
 */
export const components: Readonly<Record<string, ComponentType<Record<string, unknown>> | undefined>> = Object.fromEntries(
  Object.entries({ Button, Card, Image, Input, Stack, Text }).map(([name, component]) => [name, component as ComponentType<Record<string, unknown>>]),
);

/**
 * The sample app styles its page on `:root` and `body`. On the canvas the page is one frame among the
 * editor's own surfaces, so those two selectors become the frame's class and everything else
 * (`.ds-*`) is left as written. One source of truth: the seed's own stylesheet, rewritten on load.
 * ponytail: a regex over CSS the repo owns; a foreign stylesheet gets the iframe, not this.
 */
export const scopeToFrame = (css: string): string => css.replace(/(^|[}\s])(?::root|body)(?=\s*\{)/gu, `$1.${FRAME}`);

export const frameStylesheet = scopeToFrame(stylesheet);
