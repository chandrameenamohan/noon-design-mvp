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
  // An empty variable is how a .env file says "unset". Digits only: Number("0x50") is 80.
  PORT: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? "3000" : value))
    .pipe(z.string().regex(/^\d+$/, "PORT must be decimal digits").transform(Number).pipe(z.number().int().min(1).max(65535))),
});

type Config = { databaseUrl: string; port: number };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL, port: parsed.data.PORT };
}
