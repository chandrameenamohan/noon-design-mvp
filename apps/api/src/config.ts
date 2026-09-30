import { z } from "zod";
import { syncNodesField, type SyncNodes } from "@noon/lease";
import { DatabaseUrl, parseEnv, port } from "@noon/process/env";
import { RedisUrl } from "@noon/queue";

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
});

export type SessionConfig = { secret: string; sync: SyncNodes; ttlSeconds: number };
type Config = { databaseUrl: string; redisUrl: string; port: number; nodeEnv: "development" | "test" | "production"; sessions: SessionConfig; signIn: { ttlSeconds: number; secureCookie: boolean }; previewOrigin: string | undefined; webhookSecret: string | undefined };

// Long enough to open a socket, short enough that a leaked token is useless almost at once.
const SESSION_TTL_SECONDS = 60;
/** How long a sign-in lasts (E8.1). Fixed at sign-in, never slid: checking a session must stay a pure read. */
export const SIGN_IN_TTL_SECONDS = 7 * 24 * 60 * 60;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = parseEnv(Env, env);
  return {
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
