import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { Name, User } from "@noon/contracts";
import type { Db } from "@noon/db";
import { hashToken, isSessionToken } from "./password.ts";

/** Works out who is calling. Undefined means "nobody we recognise", which the app turns into 401. */
export type Identify = (c: Context, db: Db) => Promise<User | undefined>;

/**
 * Development only (SPEC §2.16): the caller names themselves in a header and is created on first
 * sight. It exists so that tenancy and attribution are real from epic 1. Since E8.1 every other
 * NODE_ENV knows only sign-in sessions; development keeps the header (scripts, the tunnel demo, two
 * browser windows as two people) behind a real session.
 *
 * Known costs, accepted because this never runs outside a developer's machine: anyone who can reach
 * the api can be anyone and can create users, and every request WRITES (the upsert), so it takes a
 * row lock and cannot run against a read replica. `sessionIdentity` below is a pure read.
 */
export const devHeaderIdentity: Identify = async (c, db) => {
  const email = User.shape.email.safeParse(c.req.header("x-dev-user"));
  if (!email.success) return undefined;
  // The display name is the local part, cut to what `Name` allows: a valid address may have a
  // local part far longer than a name, and that must not turn a request into a 500.
  const local = (email.data.split("@")[0] ?? "").slice(0, 200);
  return db.upsertUser({ email: email.data, name: Name.safeParse(local).data ?? "user" });
};

/** The cookie a signed-in browser carries (E8.1). HttpOnly and SameSite=Strict: see app.ts, where it is set. */
export const SESSION_COOKIE = "noon_session";

/**
 * E8.1 (F23): the caller is whoever holds a live sign-in session. The cookie's token is hashed and looked up;
 * a malformed one is never sent to the database. One indexed READ per request, no write (the E1.4 finding):
 * the expiry is fixed at sign-in, never slid forward.
 */
export const sessionIdentity: Identify = async (c, db) => {
  const token = getCookie(c, SESSION_COOKIE);
  return isSessionToken(token) ? db.userForSession(hashToken(token)) : undefined;
};

/** Development: a session first, so sign-in works there as it does everywhere, and the header when there is none. */
const developmentIdentity: Identify = async (c, db) => (await sessionIdentity(c, db)) ?? devHeaderIdentity(c, db);

/**
 * Only the literal "development" turns the header on. "test" does not: an image built in CI and
 * promoted with NODE_ENV=test must not accept it. Tests pass the strategy they want directly.
 */
export const chooseIdentity = (nodeEnv: "development" | "test" | "production"): Identify =>
  nodeEnv === "development" ? developmentIdentity : sessionIdentity;
