// Assumption 5 (fix): `import type` is erased entirely, so there's no
// runtime binding to fail to find.
import type { Config } from "./types-only.ts";

const c: Config = { debug: true };
console.log(`a5-good ${JSON.stringify(c)}`);
