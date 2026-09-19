// Lesson 0 · 7 — modules.  Run: node 07-modules.ts
// One file = one module (like Python; unlike Java's one-class-per-file + package).

import { makeOrg } from "./07-lib.ts"; //      a VALUE import: exists at runtime
import type { Org } from "./07-lib.ts"; //     a TYPE import: deleted before the code runs

// Two repo rules that come from running TypeScript directly on Node (no build step):
//  1. relative imports spell the real file name, extension included: "./07-lib.ts"
//  2. types are imported with `import type`, because after erasure there is no `Org` to import

const org: Org = makeOrg("Acme");
console.log(org);

// Packages are imported by NAME, resolved through node_modules and the package's "exports" field:
//   import { HealthResponse } from "@noon/contracts";   -> packages/contracts/package.json "exports"
// There is no classpath and no PYTHONPATH. tsconfig "paths" aliases do NOT work at runtime.

// Top-level await works in modules, and import.meta replaces __file__-style tricks.
console.log(import.meta.filename.endsWith("07-modules.ts"));
