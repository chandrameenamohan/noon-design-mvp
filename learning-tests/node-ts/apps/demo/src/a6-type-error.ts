// Assumption 6: a blatant type error does NOT stop execution at runtime;
// only `tsc --noEmit` catches it.
const bad: number = "not a number";
console.log(`a6-ran-anyway bad=${bad}`);
