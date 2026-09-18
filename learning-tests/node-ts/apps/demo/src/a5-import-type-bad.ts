// Assumption 5 (fail case): importing a type as if it were a value.
// `Config` has no runtime export once types-only.ts is stripped, so this
// should throw a SyntaxError at module load time, not a type error.
import { Config } from "./types-only.ts";

const c: Config = { debug: true };
console.log(`a5-bad ${JSON.stringify(c)}`);
