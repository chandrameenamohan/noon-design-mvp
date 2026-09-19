// EXPECT: TS2353
// Structural typing is strict about object LITERALS: an unknown extra key is almost always a typo.
type Org = { id: string; name: string };
const acme: Org = { id: "org_1", name: "Acme", nmae: "typo" };
console.log(acme);
