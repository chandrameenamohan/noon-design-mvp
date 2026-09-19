import { z } from "zod";
import { DatabaseUrl, parseEnv, port } from "@noon/process/env";

const Env = z.object({
  DATABASE_URL: DatabaseUrl,
  // Signs the tokens that open a document's WebSocket; the sync server holds the same value.
  SESSION_TOKEN_SECRET: z.string({ error: "SESSION_TOKEN_SECRET is required" }).min(32, "SESSION_TOKEN_SECRET must be at least 32 characters"),
  // The address BROWSERS use to reach the sync server (not the address inside the Docker network).
  SYNC_PUBLIC_URL: z
    .string({ error: "SYNC_PUBLIC_URL is required" })
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      // A query or fragment would swallow the "/documents/<id>" that gets appended to this address.
      return ["ws:", "wss:"].includes(url.protocol) && url.search === "" && url.hash === "";
    }, "SYNC_PUBLIC_URL must be a ws:// or wss:// URL without a query or fragment")
    .transform((value) => value.replace(/\/+$/, "")),
  // Unset means production: the safe side. Anything that relaxes security must be asked for by name.
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: port(3000),
});

export type SessionConfig = { secret: string; syncUrl: string; ttlSeconds: number };
type Config = { databaseUrl: string; port: number; nodeEnv: "development" | "test" | "production"; sessions: SessionConfig };

// Long enough to open a socket, short enough that a leaked token is useless almost at once.
const SESSION_TTL_SECONDS = 60;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = parseEnv(Env, env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    sessions: { secret: parsed.SESSION_TOKEN_SECRET, syncUrl: parsed.SYNC_PUBLIC_URL, ttlSeconds: SESSION_TTL_SECONDS },
  };
}
