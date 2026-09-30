// DRILL 2 · one bug from Lesson 8 is planted in this file. Find it and fix it HERE.
//
// POST /auth/signin cut down to its decision (apps/api/src/app.ts, with password.ts behind it): the store is asked
// for the account with that email, the password is checked against the stored hash, and the answer is the user or
// "invalid_credentials". The hashing is injected: the real one is scrypt (N=2^15, r=8: 32 MiB and some tens of
// milliseconds per guess), so the test can count the hashes and time them without paying for them. Everything the
// route does around this (parsing the body, the rate-limit seam, the cookie) is left out; the decision is the same.
import type { User } from "@noon/contracts";

export type Credentials = { user: User; passwordHash: string };
/** The users and credentials tables, as db.credentialsFor reads them: undefined when nobody has that email, or they have no password. */
export type Store = { credentialsFor(email: string): Promise<Credentials | undefined> };
export type Hashing = {
  /** Constant time over the derived key (password.ts verifyPassword). Costs one scrypt whatever the answer. */
  verify(password: string, stored: string): Promise<boolean>;
  /** A real hash of a password nobody knows, computed once (password.ts dummyHash). */
  dummy(): Promise<string>;
};
export type SignInAnswer = { ok: true; user: User } | { ok: false; error: "invalid_credentials" };

export function createSignIn({ store, hashing }: { store: Store; hashing: Hashing }) {
  const refused: SignInAnswer = { ok: false, error: "invalid_credentials" };
  return async function signIn(email: string, password: string): Promise<SignInAnswer> {
    const found = await store.credentialsFor(email);
    // Nobody has that email: there is no hash to compare against, and the answer is the same one a wrong password gets.
    if (!found) return refused;
    const matches = await hashing.verify(password, found.passwordHash);
    return matches ? { ok: true, user: found.user } : refused;
  };
}
