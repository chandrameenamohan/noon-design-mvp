// EXPECT: TS2322
// A const's literal type, and a let's widened type, are both enforced.
let attempts = 0;
attempts = "three"; // Type 'string' is not assignable to type 'number'.
console.log(attempts);
