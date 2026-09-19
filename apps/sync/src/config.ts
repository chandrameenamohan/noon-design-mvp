import { z } from "zod";
import { DatabaseUrl, parseEnv, port } from "@noon/process/env";

const Env = z.object({
  // Where documents are loaded from and saved to: the same limited role the api uses.
  DATABASE_URL: DatabaseUrl,
  // The api signs session tokens with this; the sync server verifies them. A comma-separated list
  // allows rotation without an outage: verifiers get "new,old", the signer switches, then "new".
  SESSION_TOKEN_SECRET: z
    .string({ error: "SESSION_TOKEN_SECRET is required" })
    .transform((value) => value.split(",").map((s) => s.trim()).filter(Boolean))
    .refine((secrets) => secrets.length > 0 && secrets.every((s) => s.length >= 32), "SESSION_TOKEN_SECRET: every secret must be at least 32 characters"),
  PORT: port(3001),
});

export function loadConfig(env: Record<string, string | undefined>): { databaseUrl: string; secrets: string[]; port: number } {
  const parsed = parseEnv(Env, env);
  return { databaseUrl: parsed.DATABASE_URL, secrets: parsed.SESSION_TOKEN_SECRET, port: parsed.PORT };
}
