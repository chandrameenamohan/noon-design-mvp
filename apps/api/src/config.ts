import { z } from "zod";

// Environment variables are untrusted strings like any other input: parse them once, at startup.
// No defaults for secrets or addresses: a missing DATABASE_URL must stop the process, not point it
// at some other database with a well-known password.
const Env = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Config = { databaseUrl: string; port: number };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL, port: parsed.data.PORT };
}
