// EXPECT: TS2532
// noUncheckedIndexedAccess: xs[0] is `number | undefined`, so arithmetic on it is an error until you check.
function firstPlusOne(xs: number[]): number {
  return xs[0] + 1; // Object is possibly 'undefined'.
}
console.log(firstPlusOne([]));
