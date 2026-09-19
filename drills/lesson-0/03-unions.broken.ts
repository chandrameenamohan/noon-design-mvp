// EXPECT: TS2322
// Add a member to the union, forget the case: the `never` line stops compiling.
type Op = { type: "add_node" } | { type: "remove_node" } | { type: "move_node" };
function describe(op: Op): string {
  switch (op.type) {
    case "add_node":
      return "add";
    case "remove_node":
      return "remove";
    default: {
      const unreachable: never = op; // Type '{ type: "move_node"; }' is not assignable to type 'never'.
      return unreachable;
    }
  }
}
console.log(describe({ type: "move_node" }));
