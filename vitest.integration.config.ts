import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Integration tests need the local database secret that ./init.sh wrote to .env. Only the keys the
// tests use are copied into the environment; anything else in that file stays out of the test process.
if (existsSync(".env")) {
  const env = parseEnv(readFileSync(".env", "utf8"));
  for (const key of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD"]) process.env[key] ??= env[key];
}


// Integration layer: real dependencies and real processes. Needs `./init.sh` to have been run.
export default defineConfig({
  test: {
    include: ["packages/**/*.int.test.ts", "apps/**/*.int.test.ts"],
    passWithNoTests: false,
    // Real Postgres, real HTTP, real child processes: the 5 s default is a unit-test budget. Twice a test
    // that takes 0.4 s alone timed out inside a full `make check`; cause unproven (machine load suspected).
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false, // ponytail: one file at a time keeps shared stores simple; parallelize per-schema if this gets slow
  },
});
