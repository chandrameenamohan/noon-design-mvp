import { z } from "zod";

// Same rule as the api: environment variables are untrusted input, and secrets have no defaults.
const Env = z.object({
  // The api signs session tokens with this; the sync server verifies them. A comma-separated list
  // allows rotation without an outage: verifiers get "new,old", the signer switches, then "new".
  SESSION_TOKEN_SECRET: z
    .string({ error: "SESSION_TOKEN_SECRET is required" })
    .transform((value) => value.split(",").map((s) => s.trim()).filter(Boolean))
    .refine((secrets) => secrets.length > 0 && secrets.every((s) => s.length >= 32), "SESSION_TOKEN_SECRET: every secret must be at least 32 characters"),
  PORT: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? "3001" : value))
    .pipe(z.string().regex(/^\d+$/, "PORT must be decimal digits").transform(Number).pipe(z.number().int().min(1).max(65535))),
});

export function loadConfig(env: Record<string, string | undefined>): { secrets: string[]; port: number } {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ")}`);
  }
  return { secrets: parsed.data.SESSION_TOKEN_SECRET, port: parsed.data.PORT };
}
