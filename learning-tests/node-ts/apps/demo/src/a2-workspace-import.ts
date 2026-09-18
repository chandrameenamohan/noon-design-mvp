// Assumption 2: importing @nt/lib (exports -> ./src/index.ts) through the
// node_modules symlink pnpm creates still gets type-stripped.
import { makeWidget } from "@nt/lib";

const w = makeWidget(1, "gadget");
console.log(`a2-ok widget=${JSON.stringify(w)}`);
