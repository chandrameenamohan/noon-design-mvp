// Assumption 4: constructor parameter properties are non-erasable syntax
// (they declare + assign a class field at once); should fail under plain
// type stripping.
class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
const p = new Point(1, 2);
console.log(`a4-param-props ${p.x},${p.y}`);
