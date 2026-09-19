import { readdir, readFile } from "node:fs/promises";
import { Client, Pool, type QueryResultRow } from "pg";
import { Document, Id, Name, Org, Workspace } from "@noon/contracts";
import { z } from "zod";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Everything that can be done without naming an org. Deliberately tiny. */
export type Db = {
  migrate(): Promise<void>;
  appliedMigrations(): Promise<string[]>;
  createOrg(input: { name: string }): Promise<Org>;
  getOrg(id: string): Promise<Org | undefined>;
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

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const isId = (x: string): boolean => Id.safeParse(x).success;

export function createDb({ connectionString, schema }: { connectionString: string; schema?: string }): Db {
  // `schema` goes into libpq's space-separated startup options, where a space would smuggle in
  // extra `-c` settings (the review set session_replication_role this way). Plain identifiers only.
  if (schema !== undefined && !IDENTIFIER.test(schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
  }

  // The pool lives in this closure and is never returned: there is no way to run an unscoped query from outside.
  const pool = new Pool({
    connectionString,
    application_name: "noon-db",
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  });
  // Postgres restarting, or killing an idle connection, makes the pool emit 'error'. An 'error'
  // event with no listener is an uncaught exception in Node: one dropped connection would take
  // the whole process down. The pool has already discarded the client; only the message is logged
  // (the full error object carries the connection password).
  pool.on("error", (err) => {
    process.stderr.write(`db: idle connection lost: ${err.message}\n`);
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
      let broken: Error | undefined;
      try {
        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
        for (const name of files) {
          await client.query("begin");
          try {
            // Two processes may start at once. The lock makes them take turns; everything that can
            // race, including creating the bookkeeping table, happens after it.
            await client.query("select pg_advisory_xact_lock(hashtext('noon:migrate'))");
            await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
            const done = await client.query("select 1 from schema_migrations where name = $1", [name]);
            if (done.rowCount === 0) {
              await client.query(await readFile(new URL(name, MIGRATIONS_DIR), "utf8"));
              await client.query("insert into schema_migrations (name) values ($1)", [name]);
            }
            await client.query("commit");
          } catch (err) {
            // If the connection itself died, rollback fails too; never let that hide the real error.
            await client.query("rollback").catch(() => undefined);
            broken = new Error(`migration ${name} failed`, { cause: err });
            throw broken;
          }
        }
      } finally {
        // Always release (an unreleased client starves the pool); after a failure, release WITH the
        // error so the pool destroys a connection whose transaction state is unknown.
        client.release(broken);
      }
    },

    async appliedMigrations() {
      return rows(z.object({ name: z.string() }).transform((r) => r.name), "select name from schema_migrations order by name", []);
    },

    // Inputs are parsed with the SAME contract the reader uses, BEFORE the write: a row that
    // cannot be read back must never be stored (it would make every later list throw).
    createOrg: async ({ name }) => exactlyOne(OrgRow, "insert into orgs (name) values ($1) returning *", [Name.parse(name)]),

    getOrg: async (id) => (isId(id) ? one(OrgRow, "select * from orgs where id = $1", [id]) : undefined),

    forOrg(orgId) {
      // An id that is not a UUID cannot name anything, so it means "not found" rather than a
      // Postgres 22P02 error (which would surface as a 500 and echo the caller's input).
      const orgExists = isId(orgId);
      return {
        createWorkspace: async ({ name }) => {
          if (!orgExists) throw new Error("cannot create a workspace: invalid org id");
          return exactlyOne(WorkspaceRow, "insert into workspaces (org_id, name) values ($1, $2) returning *", [orgId, Name.parse(name)]);
        },
        listWorkspaces: async () =>
          orgExists ? rows(WorkspaceRow, "select * from workspaces where org_id = $1 order by created_at, id", [orgId]) : [],
        getWorkspace: async (id) =>
          orgExists && isId(id) ? one(WorkspaceRow, "select * from workspaces where org_id = $1 and id = $2", [orgId, id]) : undefined,
        createDocument: async ({ workspaceId, title }) => {
          const cleanTitle = Name.parse(title);
          if (!orgExists || !isId(workspaceId)) return undefined;
          return one(
            DocumentRow,
            // insert ... select: the row is only created if the workspace exists in this org.
            "insert into documents (org_id, workspace_id, title) " +
              "select w.org_id, w.id, $3 from workspaces w where w.org_id = $1 and w.id = $2 returning *",
            [orgId, workspaceId, cleanTitle],
          );
        },
        listDocuments: async (workspaceId) =>
          orgExists && isId(workspaceId)
            ? rows(DocumentRow, "select * from documents where org_id = $1 and workspace_id = $2 order by created_at, id", [orgId, workspaceId])
            : [],
        getDocument: async (id) =>
          orgExists && isId(id) ? one(DocumentRow, "select * from documents where org_id = $1 and id = $2", [orgId, id]) : undefined,
      };
    },

    close: () => pool.end(),
  };
}

/**
 * Creates (or updates) the login role the application connects as, and grants it data access only:
 * no schema changes, no migration history, no superuser. Run by the owner, next to migrations.
 */
export async function provisionAppRole({ ownerUrl, schema = "public", role, password }: {
  ownerUrl: string;
  schema?: string;
  role: string;
  password: string;
}): Promise<void> {
  if (!IDENTIFIER.test(role)) throw new Error(`invalid role name: ${JSON.stringify(role)}`);
  if (!IDENTIFIER.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    // Role DDL cannot take bind parameters, so the two values are escaped by the driver.
    const r = owner.escapeIdentifier(role);
    const s = owner.escapeIdentifier(schema);
    const exists = await owner.query("select 1 from pg_roles where rolname = $1", [role]);
    await owner.query(`${exists.rowCount === 0 ? "create" : "alter"} role ${r} login nosuperuser nocreatedb nocreaterole password ${owner.escapeLiteral(password)}`);
    await owner.query(`grant usage on schema ${s} to ${r}`);
    await owner.query(`grant select, insert, update, delete on all tables in schema ${s} to ${r}`);
    await owner.query(`alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`);
    await owner.query(`revoke all on ${s}.schema_migrations from ${r}`);
  } finally {
    await owner.end();
  }
}
