// Assumption 3 (fail case): extensionless relative import of a .ts file.
import { shout } from "./helper";
console.log(`a3-no-ext ${shout("should not print")}`);
