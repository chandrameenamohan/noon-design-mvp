import { z } from "zod";
import { syncNodesField, type SyncNodes } from "@noon/lease";
import { DatabaseUrl, parseEnv, port } from "@noon/process/env";
import type { Rule } from "@noon/db";
import { RedisUrl } from "@noon/queue";
import { trustedProxies, type Trusted } from "./client-address.ts";

const Env = z.object({
  DATABASE_URL: DatabaseUrl,
  REDIS_URL: RedisUrl,
  // Signs the tokens that open a document's WebSocket; the sync server holds the same value.
  SESSION_TOKEN_SECRET: z.string({ error: "SESSION_TOKEN_SECRET is required" }).min(32, "SESSION_TOKEN_SECRET must be at least 32 characters"),
  // The address BROWSERS use to reach the sync server (not the address inside the Docker network). One URL for
  // one node; with several (E7.1) the routing table `id=url,id=url`, ids as the nodes' SYNC_NODE_ID.
  SYNC_PUBLIC_URL: syncNodesField("SYNC_PUBLIC_URL"),
  // Set when the app is reached through one public URL (a tunnel, noon-l96): the canvas's origin, whose dev
  // server carries each preview as /preview/... . Unset (or empty): the canvas frames the loopback address.
  PREVIEW_PUBLIC_URL: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => {
      if (value === undefined) return true;
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      // An ORIGIN: the preview's own path is appended to it, and nothing may ride along.
      return ["http:", "https:"].includes(url.protocol) && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
    }, "PREVIEW_PUBLIC_URL must be an http(s) origin, like https://noon.example.com")
    .transform((value) => (value === undefined ? undefined : new URL(value).origin)),
  // E5.3a: the secret Gitea signs push deliveries with (init.sh writes it to .env and into the hook). Unset: the
  // webhook answers 404 to everyone, and the git peer's reconcile alone notices pushes.
  GITEA_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || value.length >= 32, "GITEA_WEBHOOK_SECRET must be at least 32 characters"),
  // Unset means production: the safe side. Anything that relaxes security must be asked for by name.
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: port(3000),
  // F31: AI runs an org may start per hour, whatever instance it asks. Decimal digits; unset or empty: 60.
  AI_RUNS_PER_HOUR: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? "60" : value))
    .pipe(z.string().regex(/^\d+$/, "AI_RUNS_PER_HOUR must be decimal digits").transform(Number).pipe(z.number().int().min(1).max(100_000))),
  // E9.6: the peers whose X-Forwarded-For names the client (client-address.ts). Unset or empty: loopback only.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return trustedProxies(value === undefined || value === "" ? "loopback" : value);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: `TRUST_PROXY: ${(err as Error).message}` });
        return z.NEVER;
      }
    }),
});

export type SessionConfig = { secret: string; sync: SyncNodes; ttlSeconds: number };
type Config = { aiRunLimit: Rule; trustProxy: Trusted; databaseUrl: string; redisUrl: string; port: number; nodeEnv: "development" | "test" | "production"; sessions: SessionConfig; signIn: { ttlSeconds: number; secureCookie: boolean }; previewOrigin: string | undefined; webhookSecret: string | undefined };

// Long enough to open a socket, short enough that a leaked token is useless almost at once.
const SESSION_TTL_SECONDS = 60;
/** How long a sign-in lasts (E8.1). Fixed at sign-in, never slid: checking a session must stay a pure read. */
export const SIGN_IN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** F31: the default AI run limit, per org. ponytail: one limit for every org; upgrade: a column on orgs when plans differ. */
export const AI_RUN_LIMIT: Rule = { limit: 60, windowSeconds: 3600 };
/**
 * E9.6 (F31): every HTTP route but the probes and Gitea's webhook. `user`: any request a caller is known for (an open
 * editor polls about 3 a second). `address`: the routes that name no user (sign-up, sign-in, sign-out, /auth/me) and
 * any request whose caller is not recognised, per client address. `mint`: POST /documents/:id/session, per user,
 * tighter than `user` and counted before the document is looked up, so a revoked collaborator's peer that keeps
 * asking is refused cheaply. `attempt`: sign-up per email, and sign-in per email AND client address, so one address
 * gets 10 tries per 5 minutes on one account, and wrong guesses from elsewhere never lock the owner out (noon-elo.7.1).
 * `signinBrake`: sign-in per email from every address together, against guesses spread over many addresses.
 * ponytail: the brake is still a lockout, for whoever controls 5 addresses (5 x 10 per 5 minutes trips it), and a
 * guesser with 5 or more addresses gets 50 tries per 5 minutes on one account; upgrade: past the brake, ask for a
 * per-account captcha or an emailed sign-in link instead of refusing. ponytail: constants, one for everyone; upgrade:
 * env or a plan column.
 */
export const HTTP_LIMITS = {
  user: { limit: 600, windowSeconds: 60 },
  address: { limit: 300, windowSeconds: 60 },
  mint: { limit: 60, windowSeconds: 60 },
  attempt: { limit: 10, windowSeconds: 300 },
  signinBrake: { limit: 50, windowSeconds: 300 },
} satisfies Record<string, Rule>;
export type HttpLimits = typeof HTTP_LIMITS;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = parseEnv(Env, env);
  return {
    aiRunLimit: { limit: parsed.AI_RUNS_PER_HOUR, windowSeconds: AI_RUN_LIMIT.windowSeconds },
    trustProxy: parsed.TRUST_PROXY,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    sessions: { secret: parsed.SESSION_TOKEN_SECRET, sync: parsed.SYNC_PUBLIC_URL, ttlSeconds: SESSION_TTL_SECONDS },
    // Development is served over plain http (localhost, the tunnel's origin side): a Secure cookie would never come back.
    signIn: { ttlSeconds: SIGN_IN_TTL_SECONDS, secureCookie: parsed.NODE_ENV !== "development" },
    previewOrigin: parsed.PREVIEW_PUBLIC_URL,
    webhookSecret: parsed.GITEA_WEBHOOK_SECRET,
  };
}
