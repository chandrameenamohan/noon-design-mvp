// Lesson 0 · 1 — values, inference, and the one number type.  Run: node 01-values.ts

const service = "api"; // inferred as the literal type "api", not string: const can never change
let attempts = 0; //      inferred as number: let can change, so TS widens to the general type
attempts += 1;

// There is no int/long/float/double. One `number` (a 64-bit float), plus `bigint` for big integers.
const half = 1 / 2; //           0.5, not 0 (Java's int division would give 0)
const big = 2n ** 64n; //        bigint literal: note the n
const unsafe = 2 ** 53 + 1; //   numbers lose integer precision above 2^53

console.log({ service, attempts, half, big, unsafe, safe: Number.isSafeInteger(unsafe) });

// Template strings replace String.format / f-strings.
console.log(`${service} took ${attempts} attempt(s)`);

// Annotations are optional. Write them on function boundaries, let inference do the rest.
const port: number = 8080;
console.log(typeof port); // "number" — typeof is a RUNTIME operator and only knows 8 JavaScript types
