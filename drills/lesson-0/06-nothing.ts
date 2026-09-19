// Lesson 0 · 6 — two kinds of nothing.  Run: node 06-nothing.ts
// Java has null. Python has None. JavaScript has BOTH null and undefined.
//   undefined = "was never set" (missing property, missing argument, array hole)
//   null      = "deliberately empty" (SQL NULL arrives as null; JSON has null but no undefined)

type Doc = { title: string; description?: string; archivedAt: Date | null };
const doc: Doc = { title: "Checkout", archivedAt: null };

console.log(doc.description, doc.archivedAt); // undefined null

// ?.  optional chaining: stop and give undefined instead of throwing (Java: Optional.map, Python: nothing built in)
console.log(doc.description?.toUpperCase());

// ??  nullish coalescing: default ONLY for null/undefined. `||` also replaces 0, "" and false: a classic bug.
const gap = 0;
console.log(gap || 16, gap ?? 16); // 16 (wrong), 0 (right)

// strictNullChecks (part of `strict`): null/undefined are NOT members of every type, unlike Java references.
function titleLength(d: Doc | undefined): number {
  if (!d) return 0; // narrowing removes undefined
  return d.title.length;
}
console.log(titleLength(doc), titleLength(undefined));

// JSON drops undefined but keeps null: this matters for every HTTP body we send.
console.log(JSON.stringify({ a: undefined, b: null })); // {"b":null}
