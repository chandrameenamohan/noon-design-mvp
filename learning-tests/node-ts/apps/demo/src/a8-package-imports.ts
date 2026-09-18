// Assumption 8 (working alternative): package.json "imports" ("#x")
// IS understood by node's own module resolver, no build step needed.
import { shout } from "#helper";
console.log(`a8-imports-ok ${shout("works")}`);
