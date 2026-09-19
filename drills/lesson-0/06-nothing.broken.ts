// EXPECT: TS2375
// exactOptionalPropertyTypes: `description?: string` means "absent or a string", NOT "may be set to undefined".
type Doc = { title: string; description?: string };
const d: Doc = { title: "Checkout", description: undefined };
console.log(d);
