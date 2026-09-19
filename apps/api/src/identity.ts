import type { Context } from "hono";
import { User } from "@noon/contracts";
import type { Db } from "@noon/db";

/** Works out who is calling. Undefined means "nobody we recognise", which the app turns into 401. */
export type Identify = (c: Context, db: Db) => Promise<User | undefined>;

/**
 * Development only (SPEC §2.16): the caller names themselves in a header and is created on first
 * sight. It exists so that tenancy and attribution are real from epic 1; epic 8 swaps in sign-in
 * and sessions by providing a different `Identify`, and nothing else changes.
 */
export const devHeaderIdentity: Identify = async (c, db) => {
  const email = User.shape.email.safeParse(c.req.header("x-dev-user"));
  if (!email.success) return undefined;
  return db.upsertUser({ email: email.data, name: email.data.split("@")[0] ?? email.data });
};

/** Trusts nothing. Until epic 8 this is what production gets: every request is 401. */
export const noIdentity: Identify = () => Promise.resolve(undefined);

export const chooseIdentity = (nodeEnv: "development" | "test" | "production"): Identify =>
  nodeEnv === "production" ? noIdentity : devHeaderIdentity;
