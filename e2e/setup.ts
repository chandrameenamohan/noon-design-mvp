import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// The e2e layer shares Postgres and Redis with the dev stack, so the dev stack's WORKERS would take
// the jobs these tests create (their sweeps read the same `jobs` table): `worker` would hand runs to the
// real model, and `worker-sandbox` would start e2e's previews in the compose pool instead of the e2e
// worker's own. Both are stopped for the duration; teardown.ts starts them again.
// If Playwright is KILLED (kill -9), teardown never runs: `docker compose start worker worker-sandbox`.
// ponytail: a database and a Redis of its own for e2e is the upgrade.
/** @public Playwright loads this file by PATH (playwright.config.ts globalSetup), which the dead-code check cannot see. */
export default function setup(): void {
  const path = `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin`;
  execFileSync("docker", ["compose", "stop", "worker", "worker-sandbox"], { env: { ...process.env, PATH: path }, stdio: "ignore" });
  // The servers under test run FROM SOURCE, so the database must match the source too: a migration
  // added since the last ./init.sh would otherwise be a 500 in the middle of a test (it was).
  const secrets = parseEnv(readFileSync(".env", "utf8"));
  const owner = `postgres://noon:${secrets["POSTGRES_PASSWORD"] ?? ""}@localhost:${process.env["PG_PORT"] ?? secrets["PG_PORT"] ?? "5432"}/noon`;
  execFileSync(process.execPath, ["packages/db/src/migrate-cli.ts"], { env: { PATH: path, MIGRATE_DATABASE_URL: owner, APP_DB_ROLE: "noon_app", APP_DB_PASSWORD: secrets["APP_DB_PASSWORD"] ?? "" }, stdio: "ignore" });
}
