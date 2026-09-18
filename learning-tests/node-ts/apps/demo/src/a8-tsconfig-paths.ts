// Assumption 8 (fail case): tsconfig.json "paths" aliases are a tsc-only
// concept; plain `node` has no idea what "@app/helper" means.
import { shout } from "@app/helper.ts";
console.log(`a8-paths-should-not-run ${shout("x")}`);
