import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Drills run outside `make check`. D1 talks to the real dev database, so it needs the local secret.
if (existsSync(".env")) {
  const env = parseEnv(readFileSync(".env", "utf8"));
  for (const key of ["POSTGRES_PASSWORD"]) process.env[key] ??= env[key];
}

export default defineConfig({ test: { include: ["drills/**/*.drill.test.ts"], fileParallelism: false } });
