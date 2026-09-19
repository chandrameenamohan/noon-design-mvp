// Lesson 0 · 3 — unions, literal types, narrowing.  Run: node 03-unions.ts
// This is the feature Java and Python do not have, and the one this codebase leans on most.

// A literal union replaces most enums: no runtime object, just checked strings.
type RunStatus = "queued" | "running" | "succeeded" | "failed";

// A DISCRIMINATED union: every member carries a literal tag (`type`). Our four document ops look like this.
type Op =
  | { type: "add_node"; nodeId: string; parentId: string }
  | { type: "remove_node"; nodeId: string }
  | { type: "set_prop"; nodeId: string; key: string; value: unknown };

function describe(op: Op): string {
  // Narrowing: inside each case the compiler KNOWS which member it is.
  switch (op.type) {
    case "add_node":
      return `add ${op.nodeId} under ${op.parentId}`; // parentId exists only on this member
    case "remove_node":
      return `remove ${op.nodeId}`;
    case "set_prop":
      return `set ${op.key} on ${op.nodeId}`;
    default: {
      // Exhaustiveness: if someone adds a 5th op and forgets a case, `op` is no longer `never`
      // here and this line stops compiling. (Java 21 sealed interfaces + switch do the same.)
      const unreachable: never = op;
      return unreachable;
    }
  }
}

const status: RunStatus = "running";
console.log(status, "|", describe({ type: "set_prop", nodeId: "n1", key: "label", value: "Pay" }));

// `unknown` is the safe "anything": you must narrow before using it. `any` switches the checker off.
function lengthOf(x: unknown): number {
  if (typeof x === "string") return x.length; // narrowed to string
  if (Array.isArray(x)) return x.length; //      narrowed to any[]
  return 0;
}
console.log(lengthOf("four"), lengthOf([1, 2]), lengthOf(42));
