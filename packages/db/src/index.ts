import { readdir, readFile } from "node:fs/promises";
import { Pool, type QueryResultRow } from "pg";
import { Document, Org, Workspace } from "@noon/contracts";
import { z } from "zod";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Everything that can be done without naming an org. Deliberately tiny. */
export type Db = {
  migrate(): Promise<void>;
  appliedMigrations(): Promise<string[]>;
  createOrg(input: { name: string }): Promise<Org>;
  /** The ONLY way to reach tenant data: every query it runs is filtered by this org. */
  forOrg(orgId: string): OrgScope;
  close(): Promise<void>;
};

type OrgScope = {
  createWorkspace(input: { name: string }): Promise<Workspace>;
  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  /** Undefined when the workspace does not exist in THIS org. */
  createDocument(input: { workspaceId: string; title: string }): Promise<Document | undefined>;
  listDocuments(workspaceId: string): Promise<Document[]>;
  getDocument(id: string): Promise<Document | undefined>;
};

// Rows arrive as `any` from the driver. Each is parsed once, here, at the database boundary.
const timestamp = z.date().transform((d) => d.toISOString());
const OrgRow = z.object({ id: z.string(), name: z.string(), created_at: timestamp })
  .transform((r): Org => Org.parse({ id: r.id, name: r.name, createdAt: r.created_at }));
const WorkspaceRow = z.object({ id: z.string(), org_id: z.string(), name: z.string(), created_at: timestamp })
  .transform((r): Workspace => Workspace.parse({ id: r.id, orgId: r.org_id, name: r.name, createdAt: r.created_at }));
const DocumentRow = z.object({ id: z.string(), org_id: z.string(), workspace_id: z.string(), title: z.string(), created_at: timestamp })
  .transform((r): Document =>
    Document.parse({ id: r.id, orgId: r.org_id, workspaceId: r.workspace_id, title: r.title, createdAt: r.created_at }));

export function createDb({ connectionString, schema }: { connectionString: string; schema?: string }): Db {
  // The pool lives in this closure and is never returned: there is no way to run an unscoped query from outside.
  const pool = new Pool({
    connectionString,
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  });

  async function rows<T>(parser: z.ZodType<T>, sql: string, params: unknown[]): Promise<T[]> {
    const result = await pool.query<QueryResultRow>(sql, params);
    return result.rows.map((row) => parser.parse(row));
  }
  async function one<T>(parser: z.ZodType<T>, sql: string, params: unknown[]): Promise<T | undefined> {
    return (await rows(parser, sql, params))[0];
  }
  async function exactlyOne<T>(parser: z.ZodType<T>, sql: string, params: unknown[]): Promise<T> {
    const row = await one(parser, sql, params);
    if (row === undefined) throw new Error("expected exactly one row");
    return row;
  }

  return {
    async migrate() {
      const client = await pool.connect();
      try {
        await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
        for (const name of files) {
          await client.query("begin");
          try {
            // Two processes may start at once; the lock makes them take turns, the check makes the loser skip.
            await client.query("select pg_advisory_xact_lock(hashtext('noon:migrate'))");
            const done = await client.query("select 1 from schema_migrations where name = $1", [name]);
            if (done.rowCount === 0) {
              await client.query(await readFile(new URL(name, MIGRATIONS_DIR), "utf8"));
              await client.query("insert into schema_migrations (name) values ($1)", [name]);
            }
            await client.query("commit");
          } catch (err) {
            await client.query("rollback");
            throw err;
          }
        }
      } finally {
        client.release(); // always: an unreleased client is how a pool starves (learning-tests/postgres #6)
      }
    },

    async appliedMigrations() {
      return rows(z.object({ name: z.string() }).transform((r) => r.name), "select name from schema_migrations order by name", []);
    },

    createOrg: ({ name }) => exactlyOne(OrgRow, "insert into orgs (name) values ($1) returning *", [name]),

    forOrg(orgId) {
      return {
        createWorkspace: ({ name }) =>
          exactlyOne(WorkspaceRow, "insert into workspaces (org_id, name) values ($1, $2) returning *", [orgId, name]),
        listWorkspaces: () =>
          rows(WorkspaceRow, "select * from workspaces where org_id = $1 order by created_at, id", [orgId]),
        getWorkspace: (id) => one(WorkspaceRow, "select * from workspaces where org_id = $1 and id = $2", [orgId, id]),
        createDocument: ({ workspaceId, title }) =>
          one(
            DocumentRow,
            // insert ... select: the row is only created if the workspace exists in this org.
            "insert into documents (org_id, workspace_id, title) " +
              "select w.org_id, w.id, $3 from workspaces w where w.org_id = $1 and w.id = $2 returning *",
            [orgId, workspaceId, title],
          ),
        listDocuments: (workspaceId) =>
          rows(DocumentRow, "select * from documents where org_id = $1 and workspace_id = $2 order by created_at, id", [orgId, workspaceId]),
        getDocument: (id) => one(DocumentRow, "select * from documents where org_id = $1 and id = $2", [orgId, id]),
      };
    },

    close: () => pool.end(),
  };
}
