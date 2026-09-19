// One-shot: applies migrations and provisions the application's login role, as the database OWNER.
// Run before the app starts:  node packages/db/src/migrate-cli.ts
import { createDb, provisionAppRole } from "./index.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const ownerUrl = required("MIGRATE_DATABASE_URL");
const db = createDb({ connectionString: ownerUrl });
try {
  await db.migrate();
  await provisionAppRole({ ownerUrl, role: required("APP_DB_ROLE"), password: required("APP_DB_PASSWORD") });
  process.stdout.write(`migrated: ${(await db.appliedMigrations()).join(", ")}\n`);
} finally {
  await db.close();
}
