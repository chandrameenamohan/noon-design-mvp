// Assumption 4: `enum` is non-erasable syntax; should fail under plain
// type stripping (no --experimental-transform-types).
enum Color {
  Red,
  Green,
  Blue,
}
console.log(`a4-enum ${Color.Red}`);
