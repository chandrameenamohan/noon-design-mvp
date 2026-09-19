import { z } from "zod";

// Environment variables are untrusted strings like any other input: each service parses its own
// once, at startup, with these shared pieces. There are no defaults for secrets or addresses: a
// missing value must stop the process, not point it at something with a well-known password.

/** A postgres:// or postgresql:// URL with a host. Anything else, including empty, is refused. */
export const DatabaseUrl = z.string({ error: "DATABASE_URL is required" }).refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "";
}, "DATABASE_URL must be a postgres:// URL with a host");

/** Decimal digits only (Number("0x50") is 80); an empty variable is how a .env file says "unset". */
export const port = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? String(fallback) : value))
    .pipe(z.string().regex(/^\d+$/, "PORT must be decimal digits").transform(Number).pipe(z.number().int().min(1).max(65535)));

/** Parses `env` or throws ONE error that names every problem and never echoes a value. */
export function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ")}`);
}
