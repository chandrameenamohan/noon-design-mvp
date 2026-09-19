// EXPECT-RUNTIME: ERR_MODULE_NOT_FOUND
// Java/Python habit: leave the extension off. Node looks for a file literally named "./07-lib".
// @ts-expect-error — the compiler objects too; silenced here so you can see the RUNTIME failure
import { makeOrg } from "./07-lib";
console.log(makeOrg("Acme"));
