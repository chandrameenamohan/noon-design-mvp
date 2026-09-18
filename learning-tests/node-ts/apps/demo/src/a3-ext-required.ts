// Assumption 3: relative imports must include the literal .ts extension.
import { shout } from "./helper.ts";
console.log(`a3-with-ts-ext-ok ${shout("works")}`);
