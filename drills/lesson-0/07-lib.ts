// Lesson 0 · 7 (library half) — a module is a file. What it `export`s is its public API.
export type Org = { id: string; name: string };
export const makeOrg = (name: string): Org => ({ id: `org_${name.toLowerCase()}`, name });
