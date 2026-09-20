import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client, Pool, type QueryResultRow } from "pg";
import { CreateRunBody, Doc, Document, FailureReason, Id, Name, Org, Run, User, Workspace, type Page } from "@noon/contracts";
import { z } from "zod";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Everything that can be done without naming an org. Deliberately tiny. */
export type Db = {
  migrate(): Promise<void>;
  appliedMigrations(): Promise<string[]>;
  /** Finds the user with this email or creates one. Emails are compared case-insensitively. */
  upsertUser(input: { email: string; name: string }): Promise<User>;
  /** Creates the org and makes `ownerId` its owner, atomically: an org never exists without an owner. */
  createOrg(input: { name: string; ownerId: string }): Promise<Org>;
  listOrgsFor(userId: string, page?: PageInput): Promise<Page<Org> | undefined>;
  /** The org, but only if this user is a member. "Not a member" and "no such org" look the same. */
  getOrgForMember(orgId: string, userId: string): Promise<Org | undefined>;
  /** The document, but only if this user is a member of its org. Used where the path names no org. */
  getDocumentForMember(documentId: string, userId: string): Promise<Document | undefined>;
  /** Resolves if the database answers a query, rejects otherwise. */
  ping(): Promise<void>;
  /** Loading and saving a document's tree, for the sync server. Every call names the org. */
  documentStore(): DocumentStore;
  /** Claiming and finishing jobs, for the worker. Every call names the org. */
  jobStore(): JobStore;
  /** The ONLY way to reach tenant data: every query it runs is filtered by this org. */
  forOrg(orgId: string): OrgScope;
  close(): Promise<void>;
};

/** `load` gives undefined when the document does not exist IN THAT ORG; `doc` is undefined when nothing was saved yet. */
export type DocumentStore = {
  load(orgId: string, documentId: string): Promise<{ doc: Doc | undefined; seq: number } | undefined>;
  save(orgId: string, documentId: string, doc: Doc, seq: number): Promise<void>;
};

type JobKey = { queue: "ai"; jobId: string; orgId: string };
/** A job as the worker sees it. `input` is whatever the creating route validated and stored. */
export type Job = { id: string; orgId: string; documentId: string; queue: "ai"; input: Record<string, unknown>; /** Undefined once that user has been deleted. */ createdBy: string | undefined };
type JobStore = {
  /** queued -> running, atomically. Undefined when there is nothing to claim: unknown, already claimed, finished, or a job of ANOTHER queue. */
  claim(key: JobKey): Promise<Job | undefined>;
  /** running -> a terminal status. `reason` is what the user will read: anything that is not a plain name is stored as `internal`. */
  finish(key: JobKey, status: "succeeded" | "failed" | "cancelled", reason?: string): Promise<void>;
  /** The oldest jobs still waiting, across ALL orgs: what the worker offers to the queue again. */
  queued(limit: number): Promise<JobKey[]>;
  /** Has someone asked for this running job to stop? The worker asks once a second. */
  cancelRequested(key: JobKey): Promise<boolean>;
};

type PageInput = { limit?: number; cursor?: string | undefined };

type OrgScope = {
  createWorkspace(input: { name: string }): Promise<Workspace>;
  /** Undefined means the cursor is not one this server issued. */
  listWorkspaces(page?: PageInput): Promise<Page<Workspace> | undefined>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  /** Undefined when the workspace does not exist in THIS org. */
  createDocument(input: { workspaceId: string; title: string }): Promise<Document | undefined>;
  listDocuments(workspaceId: string, page?: PageInput): Promise<Page<Document> | undefined>;
  getDocument(id: string): Promise<Document | undefined>;
  /** Undefined when the document does not exist in THIS org; "busy" when it already has an unfinished run. The run starts as `queued`. */
  createRun(input: { documentId: string; instruction: string; createdBy: string | undefined }): Promise<Run | "busy" | undefined>;
  getRun(documentId: string, id: string): Promise<Run | undefined>;
  /** Queued: cancelled at once. Running: marked, and the worker ends it. Finished: unchanged. Always the run as it now is. */
  cancelRun(documentId: string, id: string): Promise<Run | undefined>;
};

// Rows arrive as `any` from the driver. Each is parsed once, here, at the database boundary.
const timestamp = z.date().transform((d) => d.toISOString());
const UserRow = z.object({ id: z.string(), email: z.string(), name: z.string() }).transform((r): User => User.parse(r));
const OrgRow = z.object({ id: z.string(), name: z.string(), created_at: timestamp })
  .transform((r): Org => Org.parse({ id: r.id, name: r.name, createdAt: r.created_at }));
const WorkspaceRow = z.object({ id: z.string(), org_id: z.string(), name: z.string(), created_at: timestamp })
  .transform((r): Workspace => Workspace.parse({ id: r.id, orgId: r.org_id, name: r.name, createdAt: r.created_at }));
const DocumentRow = z.object({ id: z.string(), org_id: z.string(), workspace_id: z.string(), title: z.string(), created_at: timestamp }) // content and seq are read only by documentStore()
  .transform((r): Document =>
    Document.parse({ id: r.id, orgId: r.org_id, workspaceId: r.workspace_id, title: r.title, createdAt: r.created_at }));

const nullableTimestamp = z.date().nullable().transform((d) => d?.toISOString() ?? null);
const RunRow = z
  .object({ id: z.string(), org_id: z.string(), document_id: z.string(), status: z.string(), input: z.object({ instruction: z.string() }), error: z.string().nullable(), created_at: timestamp, started_at: nullableTimestamp, finished_at: nullableTimestamp })
  .transform((r): Run =>
    Run.parse({ id: r.id, orgId: r.org_id, documentId: r.document_id, status: r.status, instruction: r.input.instruction, error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at }));
const JobRow = z
  .object({ id: z.string(), org_id: z.string(), document_id: z.string(), queue: z.literal("ai"), input: z.record(z.string(), z.unknown()), created_by: z.string().nullable() })
  .transform((r): Job => ({ id: r.id, orgId: r.org_id, documentId: r.document_id, queue: r.queue, input: r.input, createdBy: r.created_by ?? undefined }));

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const isId = (x: string): boolean => Id.safeParse(x).success;

// Keyset paging on (created_at, id). The cursor carries Postgres's own text form of the timestamp,
// because a JS Date keeps milliseconds while timestamptz keeps microseconds: rounding through a Date
// would skip or repeat rows created in the same millisecond.
const CURSOR_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const encodeCursor = (ts: string, id: string): string => Buffer.from(`${ts}|${id}`).toString("base64url");
function decodeCursor(cursor: string): { ts: string; id: string } | undefined {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (ts === undefined || id === undefined || rest.length > 0) return undefined;
  // Postgres prints the offset as "+00"; ISO 8601 (what Date.parse reads) needs "+00:00".
  const iso = ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  if (!CURSOR_TS.test(ts) || Number.isNaN(Date.parse(iso)) || !isId(id)) return undefined;
  return { ts, id };
}

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
    process.stderr.write(`${JSON.stringify({ level: "warn", source: "db", message: `idle connection lost: ${err.message}` })}\n`);
  });

  async function rows<T>(parser: z.ZodType<T>, sql: string, params: unknown[]): Promise<T[]> {
    const result = await pool.query<QueryResultRow>(sql, params);
    return result.rows.map((row) => parser.parse(row));
  }
  /** `from` names the paged table as alias `t`; `where` must be ready for " and ..."; the cursor adds two params. */
  async function page<T>(parser: z.ZodType<T>, from: string, where: string, params: unknown[], input: PageInput = {}): Promise<Page<T> | undefined> {
    const limit = input.limit ?? 50;
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (input.cursor !== undefined && after === undefined) return undefined;
    const n = params.length;
    const result = await pool.query<QueryResultRow & { cursor_ts: string; id: string }>(
      `select t.*, t.created_at::text as cursor_ts from ${from} where ${where}` +
        (after ? ` and (t.created_at, t.id) > ($${String(n + 1)}::timestamptz, $${String(n + 2)}::uuid)` : "") +
        ` order by t.created_at, t.id limit ${String(limit + 1)}`, // one extra row tells us whether another page exists
      after ? [...params, after.ts, after.id] : params,
    );
    const pageRows = result.rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => parser.parse(row)),
      nextCursor: result.rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
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

    ping: async () => {
      await pool.query("select 1");
    },

    upsertUser: async ({ email, name }) =>
      exactlyOne(
        UserRow,
        // "do update" (a no-op write) rather than "do nothing", so RETURNING yields the row either way.
        "insert into users (email, name) values (lower($1), $2) on conflict (email) do update set email = excluded.email returning id, email, name",
        [User.shape.email.parse(email), Name.parse(name)],
      ),

    // Inputs are parsed with the SAME contract the reader uses, BEFORE the write: a row that
    // cannot be read back must never be stored (it would make every later list throw).
    createOrg: async ({ name, ownerId }) => {
      if (!isId(ownerId)) throw new Error("cannot create an org: invalid owner id");
      return exactlyOne(
        OrgRow,
        // One statement, so it is atomic without an explicit transaction.
        "with o as (insert into orgs (name) values ($1) returning *), " +
          "m as (insert into memberships (org_id, user_id, role) select o.id, $2, 'owner' from o) select * from o",
        [Name.parse(name), ownerId],
      );
    },

    listOrgsFor: async (userId, input) =>
      isId(userId)
        ? page(OrgRow, "orgs t join memberships m on m.org_id = t.id", "m.user_id = $1", [userId], input)
        : { items: [], nextCursor: null },

    getOrgForMember: async (orgId, userId) =>
      isId(orgId) && isId(userId)
        ? one(OrgRow, "select o.* from orgs o join memberships m on m.org_id = o.id where o.id = $1 and m.user_id = $2", [orgId, userId])
        : undefined,

    documentStore: () => ({
      async load(orgId, documentId) {
        if (!isId(orgId) || !isId(documentId)) return undefined;
        const row = await one(
          // seq is a bigint, which the driver hands over as a STRING (learning-tests/postgres): convert
          // once, here. A document would need nine quadrillion ops to leave Number's safe range.
          z.object({ content: z.unknown(), seq: z.string().regex(/^\d+$/).transform(Number) }),
          "select content, seq from documents where org_id = $1 and id = $2",
          [orgId, documentId],
        );
        if (!row) return undefined;
        return { doc: row.content === null ? undefined : Doc.parse(row.content), seq: row.seq };
      },
      async save(orgId, documentId, doc, seq) {
        if (!isId(orgId) || !isId(documentId)) return;
        // `seq <= $4`: a late save from an older room must never overwrite a newer document.
        await pool.query("update documents set content = $3, seq = $4 where org_id = $1 and id = $2 and seq <= $4", [orgId, documentId, JSON.stringify(doc), seq]);
      },
    }),

    jobStore: () => ({
      // `queue = $3`: the message says which queue it came from, the ROW says which queue the job is
      // on, and they must agree BEFORE anything is written. Without it, a message on the ai queue that
      // names a git job would mark it running and then fail to parse it: running for ever.
      claim: async ({ queue, jobId, orgId }) =>
        isId(jobId) && isId(orgId)
          ? one(JobRow, "update jobs set status = 'running', started_at = now() where org_id = $1 and id = $2 and queue = $3 and status = 'queued' returning *", [orgId, jobId, queue])
          : undefined,
      async finish({ jobId, orgId }, status, reason) {
        if (!isId(jobId) || !isId(orgId)) return;
        // `status = 'running'`: a finished job stays finished, whoever reports late.
        await pool.query("update jobs set status = $3, error = $4, finished_at = now() where org_id = $1 and id = $2 and status = 'running'", [
          orgId, jobId, status, status === "failed" ? (FailureReason.safeParse(reason).success ? reason : "internal") : null,
        ]);
      },
      cancelRequested: async ({ jobId, orgId }) =>
        isId(jobId) && isId(orgId) && (await pool.query("select 1 from jobs where org_id = $1 and id = $2 and cancel_requested_at is not null", [orgId, jobId])).rowCount === 1,
      queued: (limit) =>
        rows(
          z.object({ id: z.string(), org_id: z.string(), queue: z.literal("ai") }).transform((r) => ({ queue: r.queue, jobId: r.id, orgId: r.org_id })),
          // Only the queues this code knows: the day `git` jobs exist, one of them must not stop the AI sweep for every org.
          "select id, org_id, queue from jobs where status = 'queued' and queue = 'ai' order by created_at, id limit $1",
          [limit],
        ),
    }),

    getDocumentForMember: async (documentId, userId) =>
      isId(documentId) && isId(userId)
        ? one(DocumentRow, "select d.* from documents d join memberships m on m.org_id = d.org_id where d.id = $1 and m.user_id = $2", [documentId, userId])
        : undefined,

    forOrg(orgId) {
      // An id that is not a UUID cannot name anything, so it means "not found" rather than a
      // Postgres 22P02 error (which would surface as a 500 and echo the caller's input).
      const orgExists = isId(orgId);
      return {
        createWorkspace: async ({ name }) => {
          if (!orgExists) throw new Error("cannot create a workspace: invalid org id");
          return exactlyOne(WorkspaceRow, "insert into workspaces (org_id, name) values ($1, $2) returning *", [orgId, Name.parse(name)]);
        },
        listWorkspaces: async (input) =>
          orgExists ? page(WorkspaceRow, "workspaces t", "t.org_id = $1", [orgId], input) : { items: [], nextCursor: null },
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
        listDocuments: async (workspaceId, input) =>
          orgExists && isId(workspaceId)
            ? page(DocumentRow, "documents t", "t.org_id = $1 and t.workspace_id = $2", [orgId, workspaceId], input)
            : { items: [], nextCursor: null },
        getDocument: async (id) =>
          orgExists && isId(id) ? one(DocumentRow, "select * from documents where org_id = $1 and id = $2", [orgId, id]) : undefined,
        createRun: async ({ documentId, instruction, createdBy }) => {
          const input = CreateRunBody.parse({ instruction }); // the same contract the reader uses, BEFORE the write
          if (!orgExists || !isId(documentId) || (createdBy !== undefined && !isId(createdBy))) return undefined;
          try {
            return await one(
              RunRow,
              // insert ... select: the row is only created if the document exists in this org.
              "insert into jobs (org_id, document_id, queue, input, created_by) select d.org_id, d.id, 'ai', $3, $4 from documents d where d.org_id = $1 and d.id = $2 returning *",
              [orgId, documentId, JSON.stringify(input), createdBy ?? null],
            );
          } catch (err) {
            // The unique index IS the check: "count, then insert" would let two requests at the same moment both in.
            if (err instanceof Error && "constraint" in err && err.constraint === "jobs_one_unfinished_run_per_document") return "busy";
            throw err;
          }
        },
        cancelRun: async (documentId, id) =>
          orgExists && isId(documentId) && isId(id)
            ? one(
                RunRow,
                // ONE statement decides by the status it finds, so a claim at the same moment cannot slip
                // between "is it queued?" and "cancel it". A finished run matches nothing in the update
                // and comes back as it is: cancelling twice, or too late, is not an error.
                "with hit as (update jobs set cancel_requested_at = now(), status = case status when 'queued' then 'cancelled' else status end, " +
                  "finished_at = case status when 'queued' then now() else finished_at end " +
                  "where org_id = $1 and document_id = $2 and id = $3 and queue = 'ai' and status in ('queued', 'running') returning *) " +
                  "select * from hit union all select * from jobs where org_id = $1 and document_id = $2 and id = $3 and queue = 'ai' and not exists (select 1 from hit)",
                [orgId, documentId, id],
              )
            : undefined,
        getRun: async (documentId, id) =>
          orgExists && isId(documentId) && isId(id)
            ? one(RunRow, "select * from jobs where org_id = $1 and document_id = $2 and id = $3 and queue = 'ai'", [orgId, documentId, id])
            : undefined,
      };
    },

    close: () => pool.end(),
  };
}

/**
 * What Postgres stores for a SCRAM password. Computing it here means the cleartext never appears
 * in a SQL statement, so it cannot land in the server log when the statement fails
 * (role DDL cannot take bind parameters). RFC 5802; ASCII passwords only (no SASLprep).
 */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

/**
 * Creates (or resets) the login role the application connects as, with data access only: no schema
 * changes, no migration history, no superuser. Run by the owner, next to migrations. It RESETS the
 * role every time: an attribute or membership picked up some other way does not survive a deploy.
 */
export async function provisionAppRole({ ownerUrl, schema = "public", role, password }: {
  ownerUrl: string;
  schema?: string;
  role: string;
  password: string;
}): Promise<void> {
  if (!IDENTIFIER.test(role)) throw new Error(`invalid role name: ${JSON.stringify(role)}`);
  if (!IDENTIFIER.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error("the app role password must be printable ASCII");
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    const r = owner.escapeIdentifier(role);
    const s = owner.escapeIdentifier(schema);
    const exists = await owner.query("select 1 from pg_roles where rolname = $1", [role]);
    await owner.query(
      `${exists.rowCount === 0 ? "create" : "alter"} role ${r} login nosuperuser nocreatedb nocreaterole nobypassrls noreplication inherit ` +
        `connection limit -1 valid until 'infinity' password ${owner.escapeLiteral(scramVerifier(password))}`,
    );
    const memberships = await owner.query<{ parent: string }>(
      "select p.rolname as parent from pg_auth_members m join pg_roles p on p.oid = m.roleid join pg_roles c on c.oid = m.member where c.rolname = $1",
      [role],
    );
    for (const { parent } of memberships.rows) await owner.query(`revoke ${owner.escapeIdentifier(parent)} from ${r}`);

    await owner.query(`grant usage on schema ${s} to ${r}`);
    await owner.query(`grant select, insert, update, delete on all tables in schema ${s} to ${r}`);
    await owner.query(`grant usage, select on all sequences in schema ${s} to ${r}`);
    await owner.query(`alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`);
    await owner.query(`alter default privileges in schema ${s} grant usage, select on sequences to ${r}`);
    await owner.query(`revoke all on ${s}.schema_migrations from ${r}`);

    // Postgres gives everyone CONNECT and TEMP on every database by default. The app needs neither
    // beyond its own database: no scratch disk writes, and a leaked password opens one database only.
    const db = owner.escapeIdentifier((await owner.query<{ name: string }>("select current_database() as name")).rows[0]?.name ?? "");
    await owner.query(`revoke temporary on database ${db} from public`);
    await owner.query(`grant connect on database ${db} to ${r}`);
    for (const other of (await owner.query<{ datname: string }>("select datname from pg_database where datname <> current_database() and datallowconn")).rows) {
      await owner.query(`revoke connect on database ${owner.escapeIdentifier(other.datname)} from public`);
    }
  } finally {
    await owner.end();
  }
}
