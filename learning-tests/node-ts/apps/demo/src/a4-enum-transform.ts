// Same enum as a4-enum.ts, but meant to be run WITH
// --experimental-transform-types to show that flag changes the outcome.
enum Color {
  Red,
  Green,
  Blue,
}
console.log(`a4-enum-transform ${Color.Red},${Color.Green},${Color.Blue}`);
