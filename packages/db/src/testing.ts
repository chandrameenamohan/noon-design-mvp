import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createDb, type Db } from "./index.ts";

const TEST_DATABASE_URL =
  process.env["DATABASE_URL"] ?? `postgres://noon:noon-dev-only@localhost:${process.env["PG_PORT"] ?? "5432"}/noon`;

export type TestDb = {
  db: Db;
  /** Raw SQL, for proving what the DATABASE refuses. Production code has no such door. */
  rawQuery(sql: string, params?: unknown[]): Promise<unknown>;
  columnsByTable(): Promise<Record<string, string[]>>;
  drop(): Promise<void>;
};

/** A migrated database inside its own throwaway Postgres schema, so test files never see each other's rows. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  await admin.connect();
  await admin.query(`create schema ${schema}`);

  const db = createDb({ connectionString: TEST_DATABASE_URL, schema });
  await db.migrate();

  return {
    db,
    rawQuery: (sql, params = []) => admin.query(sql, params),
    async columnsByTable() {
      const res = await admin.query<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = $1",
        [schema],
      );
      const out: Record<string, string[]> = {};
      for (const { table_name, column_name } of res.rows) (out[table_name] ??= []).push(column_name);
      return out;
    },
    async drop() {
      await db.close();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
