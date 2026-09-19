// EXPECT: TS2339
// Forgetting `await` gives you the Promise, not the value. The type system catches it.
async function fetchOrg(): Promise<{ id: string }> {
  return { id: "org_1" };
}
const org = fetchOrg(); // missing await
console.log(org.id); // Property 'id' does not exist on type 'Promise<{ id: string; }>'.
