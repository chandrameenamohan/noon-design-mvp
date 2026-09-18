// Assumption 3 (fail case): .js-suffixed relative import of a .ts file
// (the TS "import the compiled extension" convention) with no build step.
import { shout } from "./helper.js";
console.log(`a3-js-ext ${shout("should not print")}`);
