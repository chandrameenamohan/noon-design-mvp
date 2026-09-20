import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// The e2e layer shares Postgres and Redis with the dev stack, so the dev stack's WORKER would take
// the runs these tests create (its sweep reads the same `jobs` table) and hand them to the real
// model. It is stopped for the duration; teardown.ts starts it again.
// If Playwright is KILLED (kill -9), teardown never runs and the worker stays stopped: `docker compose start worker`.
// ponytail: a database and a Redis of its own for e2e is the upgrade.
/** @public Playwright loads this file by PATH (playwright.config.ts globalSetup), which the dead-code check cannot see. */
export default function setup(): void {
  const path = `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin`;
  execFileSync("docker", ["compose", "stop", "worker"], { env: { ...process.env, PATH: path }, stdio: "ignore" });
  // The servers under test run FROM SOURCE, so the database must match the source too: a migration
  // added since the last ./init.sh would otherwise be a 500 in the middle of a test (it was).
  const secrets = parseEnv(readFileSync(".env", "utf8"));
  const owner = `postgres://noon:${secrets["POSTGRES_PASSWORD"] ?? ""}@localhost:${process.env["PG_PORT"] ?? secrets["PG_PORT"] ?? "5432"}/noon`;
  execFileSync(process.execPath, ["packages/db/src/migrate-cli.ts"], { env: { PATH: path, MIGRATE_DATABASE_URL: owner, APP_DB_ROLE: "noon_app", APP_DB_PASSWORD: secrets["APP_DB_PASSWORD"] ?? "" }, stdio: "ignore" });
}
