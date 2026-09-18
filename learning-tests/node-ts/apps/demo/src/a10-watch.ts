// Assumption 10: `node --watch` should restart when an imported WORKSPACE
// package .ts file changes (reached via the node_modules symlink), not
// just when files inside apps/demo itself change.
import { LIB_VERSION } from "@nt/lib";
console.log(`a10-watch-tick LIB_VERSION=${LIB_VERSION} t=${Date.now()}`);
