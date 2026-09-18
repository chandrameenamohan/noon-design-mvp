// Assumption 4: `namespace` with a real value (not just types) is
// non-erasable syntax; should fail under plain type stripping.
namespace Shapes {
  export const circleSides = 0;
}
console.log(`a4-namespace ${Shapes.circleSides}`);
