// Lesson 0 · 4 — functions and generics.  Run: node 04-functions.ts

// Functions are values. Both forms are everywhere; arrows are the norm for callbacks.
function add(a: number, b: number): number {
  return a + b;
}
const double = (n: number): number => n * 2;

// Optional and default parameters (no overloading by signature like Java).
function page(items: string[], size = 2, from?: number): string[] {
  const start = from ?? 0;
  return items.slice(start, start + size);
}

// Generics: like Java's, erased at runtime like Java's, but inferred at the call site far more often.
function first<T>(xs: readonly T[]): T | undefined {
  return xs[0]; // T | undefined: an empty array has no first element, and TS makes you say so
}

// A generic constraint (`extends`) = Java's bounded type parameter.
function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.id, r]));
}

console.log(add(2, 3), double(4), page(["a", "b", "c"]), page(["a", "b", "c"], 1, 2));
console.log(first([10, 20]), first([]));
console.log(byId([{ id: "o1", name: "Acme" }]).get("o1"));

// Object parameter + destructuring is how "named arguments" are done.
function createDoc({ title, orgId }: { title: string; orgId: string }): string {
  return `${orgId}/${title}`;
}
console.log(createDoc({ orgId: "org_1", title: "Checkout" }));
