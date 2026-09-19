import { z } from "zod";

// Environment variables are untrusted strings like any other input: parse them once, at startup.
// No defaults for secrets or addresses: a missing or garbage DATABASE_URL must stop the process,
// not let it start "healthy" while pointing at nothing.
const Env = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "";
    }, "DATABASE_URL must be a postgres:// URL with a host"),
  // Signs the tokens that open a document's WebSocket; the sync server holds the same value.
  SESSION_TOKEN_SECRET: z.string({ error: "SESSION_TOKEN_SECRET is required" }).min(32, "SESSION_TOKEN_SECRET must be at least 32 characters"),
  // The address BROWSERS use to reach the sync server (not the address inside the Docker network).
  SYNC_PUBLIC_URL: z
    .string({ error: "SYNC_PUBLIC_URL is required" })
    .refine((value) => URL.canParse(value) && ["ws:", "wss:"].includes(new URL(value).protocol), "SYNC_PUBLIC_URL must be a ws:// or wss:// URL")
    .transform((value) => value.replace(/\/+$/, "")),
  // Unset means production: the safe side. Anything that relaxes security must be asked for by name.
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  // An empty variable is how a .env file says "unset". Digits only: Number("0x50") is 80.
  PORT: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? "3000" : value))
    .pipe(z.string().regex(/^\d+$/, "PORT must be decimal digits").transform(Number).pipe(z.number().int().min(1).max(65535))),
});

export type SessionConfig = { secret: string; syncUrl: string; ttlSeconds: number };
type Config = { databaseUrl: string; port: number; nodeEnv: "development" | "test" | "production"; sessions: SessionConfig };

// Long enough to open a socket, short enough that a leaked token is useless almost at once.
const SESSION_TTL_SECONDS = 60;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    nodeEnv: parsed.data.NODE_ENV,
    sessions: { secret: parsed.data.SESSION_TOKEN_SECRET, syncUrl: parsed.data.SYNC_PUBLIC_URL, ttlSeconds: SESSION_TTL_SECONDS },
  };
}
