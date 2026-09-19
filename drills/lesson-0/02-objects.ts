// Lesson 0 · 2 — object types and STRUCTURAL typing.  Run: node 02-objects.ts

// Two ways to name an object shape. Rule of thumb in this repo: `type` by default,
// `interface` when something is meant to be extended or implemented.
type Org = { readonly id: string; name: string; plan?: "free" | "team" };
interface HasName { name: string }

const acme: Org = { id: "org_1", name: "Acme" }; // plan is optional, so it may be absent

// Structural typing: a value fits a type if it has the right SHAPE.
// Org never declares "implements HasName" (Java would require that). It just has a name.
function greet(x: HasName): string {
  return `hello ${x.name}`;
}
console.log(greet(acme));
console.log(greet({ name: "anything with a name" }));

// A class is not special either: this object literal is a valid Point.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
const p: Point = { x: 1, y: 2 }; // no `new`, no inheritance, still a Point: only the shape matters
console.log(p, p instanceof Point); // instanceof is a RUNTIME check and says false

// readonly is compile-time only; it is erased like every other type.
console.log(Object.isFrozen(acme)); // false
