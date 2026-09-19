import type { Context } from "hono";
import { Name, User } from "@noon/contracts";
import type { Db } from "@noon/db";

/** Works out who is calling. Undefined means "nobody we recognise", which the app turns into 401. */
export type Identify = (c: Context, db: Db) => Promise<User | undefined>;

/**
 * Development only (SPEC §2.16): the caller names themselves in a header and is created on first
 * sight. It exists so that tenancy and attribution are real from epic 1; epic 8 swaps in sign-in
 * and sessions by providing a different `Identify`, and nothing else changes.
 *
 * Known costs, accepted because this never runs outside a developer's machine: anyone who can reach
 * the api can be anyone and can create users, and every request WRITES (the upsert), so it takes a
 * row lock and cannot run against a read replica. Epic 8's strategy must be a pure read.
 */
export const devHeaderIdentity: Identify = async (c, db) => {
  const email = User.shape.email.safeParse(c.req.header("x-dev-user"));
  if (!email.success) return undefined;
  // The display name is the local part, cut to what `Name` allows: a valid address may have a
  // local part far longer than a name, and that must not turn a request into a 500.
  const local = (email.data.split("@")[0] ?? "").slice(0, 200);
  return db.upsertUser({ email: email.data, name: Name.safeParse(local).data ?? "user" });
};

/** Trusts nothing. Until epic 8 this is what every non-development process gets: all requests are 401. */
export const noIdentity: Identify = () => Promise.resolve(undefined);

/**
 * Only the literal "development" turns the header on. "test" does not: an image built in CI and
 * promoted with NODE_ENV=test must not accept it. Tests pass the strategy they want directly.
 */
export const chooseIdentity = (nodeEnv: "development" | "test" | "production"): Identify =>
  nodeEnv === "development" ? devHeaderIdentity : noIdentity;
