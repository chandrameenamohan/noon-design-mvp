// Regenerates packages/design-system/manifest.json from the design system's source.  Run: make manifest
import { writeFileSync } from "node:fs";
import { extractManifest, serializeManifest } from "./extract.ts";

// Not imported from index.ts: that module loads manifest.json, which may not exist yet.
const entry = new URL("../../../seed/sample-app/src/design-system/index.ts", import.meta.url).pathname;
const out = new URL("../manifest.json", import.meta.url).pathname;
const manifest = extractManifest(entry);
writeFileSync(out, serializeManifest(manifest));
process.stdout.write(`wrote ${out}: ${manifest.components.map((c) => c.name).join(", ")}\n`);
