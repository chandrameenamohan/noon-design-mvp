// DRILL 2 · one bug from Lesson 9 is planted in this file. Find it and fix it HERE.
//
// `withKey` of packages/db/src/index.ts cut down to its decision (E9.1, F27): a press of "Ask the AI" or "Ship"
// arrives with an Idempotency-Key, and that key must make ONE job however many requests carry it, at the same
// moment or later. The store stands for the idempotency_keys table (migration 0018), and every call to it is a
// round trip, so there is an `await` between any two of them; in an `await` anything can happen, the other
// nineteen requests for instance. The real one claims the key inside a transaction with `insert ... on conflict
// do nothing`, and a loser blocks on the winner's row until it commits; here the row holds a promise of the job
// and a loser awaits it. Left out: the 24 h expiry, the org half of the scope, the transaction, the request stored
// as jsonb (here a string).
export type Row = {
  /** What was asked (queue, document, input), so the same key for anything else can be refused. */
  request: string;
  /** The job the request that holds the key made, once it has; undefined when it made none (busy, gone). */
  job: Promise<string | undefined>;
};
export type Store = {
  /** The row this user's key holds, if any. */
  find(user: string, key: string): Promise<Row | undefined>;
  /** Writes the row, whatever was there before. */
  put(user: string, key: string, row: Row): Promise<void>;
  /** `insert ... on conflict do nothing`: `row` is written only if the key was free, and the answer says which row is held now and whether this call put it there. */
  claim(user: string, key: string, row: Row): Promise<{ held: Row; mine: boolean }>;
  /** Drops the row: the key is free again (the claim rolled back). */
  forget(user: string, key: string): Promise<void>;
};
/** `made`: this request made the job. `replay`: an earlier request with the key did, and this is it. `nothing`: no job was made (the route answers 409 or 404 from `make`'s own reason). */
export type Answer = { made: string } | { replay: string } | "key_reused" | "nothing";

/** What the holder of the key is answered with, once the row that claimed it knows its job. */
async function answerFrom(held: Row, request: string): Promise<Answer> {
  if (held.request !== request) return "key_reused";
  const job = await held.job;
  return job === undefined ? "nothing" : { replay: job };
}

export function createWithKey(store: Store) {
  /** `make` makes the job and answers its id, or undefined when it made none: then the key is not used up, and the retry after the 409 may use it. */
  return async function withKey(user: string, key: string, request: string, make: () => Promise<string | undefined>): Promise<Answer> {
    const found = await store.find(user, key);
    // Someone holds the key already: they made the job (or are making it), and this request is answered with theirs.
    if (found) return answerFrom(found, request);
    // Nobody holds it: this request makes the job and records it under the key, so the next one finds it.
    const { promise: job, resolve } = Promise.withResolvers<string | undefined>();
    await store.put(user, key, { request, job });
    let id: string | undefined;
    try {
      id = await make();
    } catch (err) {
      await store.forget(user, key); // rolled back: the key names no job
      throw err;
    } finally {
      resolve(id);
    }
    if (id === undefined) {
      await store.forget(user, key);
      return "nothing";
    }
    return { made: id };
  };
}
