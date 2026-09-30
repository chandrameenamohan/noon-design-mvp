import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client, Pool, type QueryResultRow } from "pg";
import { Conflict, CreateRunBody, Doc, Document, FailureReason, Id, Name, Org, Preview, PreviewOutput, Run, SandboxUrl, Ship, ShipOutput, UsageAmount, UsageReport, User, Workspace, type Page } from "@noon/contracts";
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
  /** The git peer's inbox (E5.3a): the stack's one repo, so no org. */
  gitStore(): GitStore;
  /** The ONLY way to reach tenant data: every query it runs is filtered by this org. */
  forOrg(orgId: string): OrgScope;
  close(): Promise<void>;
};

/** `load` gives undefined when the document does not exist IN THAT ORG; `doc` is undefined when nothing was saved yet. */
export type DocumentStore = {
  load(orgId: string, documentId: string): Promise<{ doc: Doc | undefined; seq: number } | undefined>;
  save(orgId: string, documentId: string, doc: Doc, seq: number): Promise<void>;
};

const QUEUES = ["ai", "sandbox", "ship"] as const;
type JobKey = { queue: (typeof QUEUES)[number]; jobId: string; orgId: string };
/** A job as the worker sees it. `input` is whatever the creating route validated and stored. */
export type Job = { id: string; orgId: string; documentId: string; queue: JobKey["queue"]; input: Record<string, unknown>; /** Undefined once that user has been deleted. */ createdBy: string | undefined };
type JobStore = {
  /** queued -> running, atomically. Undefined when there is nothing to claim: unknown, already claimed, finished, or a job of ANOTHER queue. */
  claim(key: JobKey): Promise<Job | undefined>;
  /** running -> a terminal status. `reason` is what the user will read: anything that is not a plain name is stored as `internal`. */
  finish(key: JobKey, status: "succeeded" | "failed" | "cancelled", reason?: string): Promise<void>;
  /** The oldest jobs still waiting, across ALL orgs: what the worker offers to the queue again. */
  queued(limit: number): Promise<JobKey[]>;
  /** Has someone asked for this running job to stop? The worker asks once a second. */
  cancelRequested(key: JobKey): Promise<boolean>;
  /** What this job consumed, against ITS org (taken from the row; a key under another org writes nothing). Once per job. */
  recordUsage(key: JobKey, amount: UsageAmount): Promise<void>;
  /**
   * What a RUNNING job has to say before it ends: a sandbox's preview URL (null while it restarts), a ship's
   * commit and pull request. Validated by the key's queue; a job that is not running is left as it is.
   */
  report(key: JobKey, output: PreviewOutput | ShipOutput | null): Promise<void>;
  /**
   * Documents whose sandbox must stay, across ALL orgs: a sandbox job queued or running, or finished
   * less than `graceMs` ago (a quick reopen finds it warm). The reaper removes every other sandbox.
   */
  sandboxesInUse(graceMs: number): Promise<string[]>;
};

/** "This branch now points at this commit": what the webhook and the reconcile both record (E5.3a). */
export type GitEvent = { id: string; ref: string; before: string; after: string };
export type GitStore = {
  /**
   * Records a commit event. False when it was known already: the same delivery again, or this commit on
   * this branch (the webhook and the reconcile raced, or a delivery was replayed under a new id). The
   * unique constraints decide. ponytail: a branch moved back to a commit it held before (a force-push
   * A -> B -> A) is taken as known; ceiling: such reverts go unseen; upgrade: key on (ref, before, after).
   */
  record(event: { ref: string; before: string; after: string; deliveryId?: string }): Promise<boolean>;
  /** The newest recorded commit of every branch: what the reconcile compares the mirror with. */
  heads(): Promise<Map<string, string>>;
  /** The oldest waiting event, pending -> running. Undefined when nothing waits. */
  claim(): Promise<GitEvent | undefined>;
  /** Ends a running event. `pending` hands it back: Gitea was away, and the event must not be lost over it. */
  finish(id: string, status: "done" | "failed" | "pending"): Promise<void>;
  /** A document was opened: the git peer reconciles soon. Requests coalesce into one flag. */
  requestReconcile(): Promise<void>;
  /** Clears the flag; true when it was set. Called as a reconcile STARTS, so an open during it sets it again. */
  takeReconcileRequest(): Promise<boolean>;
  /**
   * The org a generated page's document belongs to, for the git peer's session (E5.3b). Across orgs, as
   * the repo is the stack's one: the page's path names the document and nothing else. Undefined: none.
   */
  documentOrg(documentId: string): Promise<string | undefined>;
  /**
   * E5.4 (F16b): a push to the document's branch was refused and changed nothing; the canvas shows it. It
   * replaces the conflict the document had. A document that no longer exists: nothing is written.
   */
  recordConflict(documentId: string, conflict: Omit<Conflict, "at">): Promise<void>;
  /** A later push to the document's branch was applied: the conflict no longer stands. */
  clearConflict(documentId: string): Promise<void>;
  /** E5.5: did a ship job make this commit? Its page is the document as it was, so the git peer skips it. */
  shippedCommit(sha: string): Promise<boolean>;
};
// The same rules the table's checks hold, parsed BEFORE the write: a bad value is a caller's bug, named here.
const GitSha = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
const GitEventInput = z.object({ ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/), before: GitSha, after: GitSha, deliveryId: z.string().regex(/^[\x21-\x7e]{1,100}$/).optional() });
// `detail` is parse's words about a file an engineer wrote: capped here, not refused (the conflict must still be shown).
const ConflictInput = Conflict.omit({ at: true, detail: true }).extend({ detail: z.string().transform((d) => d.slice(0, 300)) });
const GitEventRow = z.object({ id: z.string(), ref: z.string(), before_sha: z.string(), after_sha: z.string() })
  .transform((r): GitEvent => ({ id: r.id, ref: r.ref, before: r.before_sha, after: r.after_sha }));

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
  /**
   * Makes sure the document has a preview on its way: a queued sandbox job, unless one is already
   * unfinished (the unique index decides; never two). `created` is the new job's key, to enqueue.
   * Undefined when the document does not exist in THIS org; "busy" when the org already holds its
   * share of sandboxes.
   */
  openPreview(input: { documentId: string; createdBy: string | undefined }): Promise<{ preview: Preview; created: JobKey | undefined } | "busy" | undefined>;
  /** The document's preview as it now is. Undefined when the document does not exist in THIS org. */
  getPreview(documentId: string): Promise<Preview | undefined>;
  /** The newest push to the document's branch that changed nothing (F16b); null: none stands. Undefined: no such document in THIS org. */
  getConflict(documentId: string): Promise<Conflict | null | undefined>;
  /**
   * F17: makes sure a ship is waiting for the document: a queued ship job, unless one is waiting already (the
   * unique index decides; presses coalesce into it). `created` is the new job's key, to enqueue. Undefined when
   * the document does not exist in THIS org.
   */
  startShip(input: { documentId: string; createdBy: string | undefined }): Promise<{ ship: Ship; created: JobKey | undefined } | undefined>;
  /** The document's newest ship; null: never shipped. Undefined when the document does not exist in THIS org. */
  getShip(documentId: string): Promise<Ship | null | undefined>;
  /** Queued: cancelled at once. Running: marked, and the worker ends it. Finished: unchanged. Always the run as it now is. */
  cancelRun(documentId: string, id: string): Promise<Run | undefined>;
  /** Everything this org has consumed: totals over all of it, and one page of the records. Undefined = a bad cursor. */
  usage(page?: PageInput): Promise<UsageReport | undefined>;
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

// A left join from the document: no conflict row = every column null.
const ConflictRow = z.object({ commit_sha: z.string().nullable(), file: z.string().nullable(), reason: z.string().nullable(), detail: z.string().nullable(), created_at: z.date().nullable() })
  .transform((r): Conflict | null => (r.commit_sha === null ? null : Conflict.parse({ commit: r.commit_sha, file: r.file, reason: r.reason, detail: r.detail, at: r.created_at?.toISOString() })));
const nullableTimestamp = z.date().nullable().transform((d) => d?.toISOString() ?? null);
const RunRow = z
  .object({ id: z.string(), org_id: z.string(), document_id: z.string(), status: z.string(), input: z.object({ instruction: z.string() }), error: z.string().nullable(), created_at: timestamp, started_at: nullableTimestamp, finished_at: nullableTimestamp })
  .transform((r): Run =>
    Run.parse({ id: r.id, orgId: r.org_id, documentId: r.document_id, status: r.status, instruction: r.input.instruction, error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at }));
// bigint and numeric arrive as STRINGS from the driver (learning-tests/postgres): converted once, here.
// Safe because UsageAmount caps what may be WRITTEN at Number.MAX_SAFE_INTEGER, so no stored token count
// (and no sum of them worth reading) leaves the range a JS number holds exactly.
const count = z.string().regex(/^\d+$/).transform(Number);
const money = z.string().regex(/^\d+(\.\d+)?$/).transform(Number);
const UsageRow = z
  .object({ id: z.string(), org_id: z.string(), job_id: z.string().nullable(), document_id: z.string().nullable(), kind: z.string(), model: z.string(), input_tokens: count, output_tokens: count, cache_read_tokens: count, cache_write_tokens: count, cost_usd: money, created_at: timestamp })
  .transform((r): UsageReport["items"][number] =>
    UsageReport.shape.items.element.parse({ id: r.id, orgId: r.org_id, runId: r.job_id, documentId: r.document_id, kind: r.kind, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: r.cost_usd, createdAt: r.created_at }));
const UsageTotalsRow = z
  .object({ runs: count, input_tokens: count, output_tokens: count, cache_read_tokens: count, cache_write_tokens: count, cost_usd: money })
  .transform((r): UsageReport["totals"] => ({ runs: r.runs, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: r.cost_usd }));
const JobRow = z
  .object({ id: z.string(), org_id: z.string(), document_id: z.string(), queue: z.enum(QUEUES), input: z.record(z.string(), z.unknown()), created_by: z.string().nullable() })
  .transform((r): Job => ({ id: r.id, orgId: r.org_id, documentId: r.document_id, queue: r.queue, input: r.input, createdBy: r.created_by ?? undefined }));

// A ship's output is written by our own worker, but read as untrusted all the same: a row that does not parse reads as "nothing yet".
const ShipRow = z
  .object({ id: z.string(), document_id: z.string(), status: z.string(), error: z.string().nullable(), output: z.unknown(), created_at: timestamp, finished_at: nullableTimestamp })
  .transform((r): Ship => {
    const output = ShipOutput.safeParse(r.output);
    return Ship.parse({ id: r.id, documentId: r.document_id, status: r.status, error: r.error, commit: output.success ? output.data.commit : null, pr: output.success ? output.data.pr : null, createdAt: r.created_at, finishedAt: r.finished_at });
  });

// The URL only counts while the job runs: a finished job's last address may belong to someone else by now.
// Parsed as a sandbox's address (loopback only); a row that is not one reads as "no URL", never a 500.
const PreviewRow = z.object({ status: z.string(), output: z.unknown() }).transform((r): Preview => {
  const url = r.status === "running" ? SandboxUrl.safeParse((r.output as { url?: unknown } | null)?.url) : undefined;
  return Preview.parse({ status: r.status, url: url?.success ? url.data : null });
});
/**
 * After a preview FAILED (or was cancelled), this long before another may be started for that document.
 * The canvas asks again every second while there is no preview; without this, a sandbox that cannot start
 * (no image, no daemon) grew one jobs row per second per open canvas. A client cannot walk around it.
 */
const PREVIEW_RETRY_MS = 10_000;
/** Sandboxes one org may hold at once (each is 1 CPU and 1 GiB while its document is open): the rest of the pool stays for everyone else. */
const MAX_PREVIEWS_PER_ORG = 4;

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
  /** One statement, returning ids, in a transaction that holds the org's advisory lock: one at a time per org. */
  async function inOrgTurn(orgId: string, sql: string, params: unknown[]): Promise<{ id: string }[]> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('noon:preview:' || $1))", [orgId]);
      const result = (await client.query<QueryResultRow>(sql, params)).rows.map((row) => z.object({ id: z.string() }).parse(row));
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      broken = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      client.release(broken); // after a failure the connection's transaction state is unknown: destroyed
    }
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
      async recordUsage({ jobId, orgId }, amount) {
        if (!isId(jobId) || !isId(orgId)) return;
        const a = UsageAmount.parse(amount); // the same contract the reader uses, BEFORE the write
        // insert ... select FROM THE JOB: org, document and user are what the row says, never what a caller
        // says, and a key that names the job under another org selects nothing. `on conflict`: billed once.
        await pool.query(
          "insert into usage (org_id, job_id, document_id, user_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) " +
            "select j.org_id, j.id, j.document_id, j.created_by, 'ai_run', $3, $4, $5, $6, $7, $8 from jobs j where j.org_id = $1 and j.id = $2 on conflict (job_id) do nothing",
          [orgId, jobId, a.model, a.inputTokens, a.outputTokens, a.cacheReadTokens, a.cacheWriteTokens, a.costUsd.toFixed(6)],
        );
      },
      queued: (limit) =>
        rows(
          z.object({ id: z.string(), org_id: z.string(), queue: z.enum(QUEUES) }).transform((r) => ({ queue: r.queue, jobId: r.id, orgId: r.org_id })),
          // Only the queues this code knows: the day `git` jobs exist, one of them must not stop the sweep for every org.
          "select id, org_id, queue from jobs where status = 'queued' and queue = any($2) order by created_at, id limit $1",
          [limit, QUEUES],
        ),
      async report({ queue, jobId, orgId }, output) {
        const valid = (queue === "ship" ? ShipOutput : PreviewOutput).nullable().parse(output); // the contract the reader will use, BEFORE the write
        if (!isId(jobId) || !isId(orgId)) return;
        await pool.query("update jobs set output = $3 where org_id = $1 and id = $2 and status = 'running'", [orgId, jobId, JSON.stringify(valid)]);
      },
      sandboxesInUse: (graceMs) =>
        rows(
          z.object({ document_id: z.string() }).transform((r) => r.document_id),
          "select distinct document_id from jobs where queue = 'sandbox' and (status in ('queued', 'running') or finished_at > now() - make_interval(secs => $1::float8 / 1000))",
          [graceMs],
        ),
    }),

    gitStore: () => ({
      async record(input) {
        const e = GitEventInput.parse(input);
        // `on conflict do nothing` with no target: EITHER unique key (delivery, or branch + commit) makes it a no-op.
        const result = await pool.query("insert into git_events (ref, before_sha, after_sha, delivery_id) values ($1, $2, $3, $4) on conflict do nothing returning id", [e.ref, e.before, e.after, e.deliveryId ?? null]);
        return result.rowCount === 1;
      },
      heads: async () =>
        new Map(await rows(
          z.object({ ref: z.string(), after_sha: z.string() }).transform((r): [string, string] => [r.ref, r.after_sha]),
          "select distinct on (ref) ref, after_sha from git_events order by ref, created_at desc, id desc",
          [],
        )),
      // `skip locked`: two peers never claim one event, and neither waits for the other.
      claim: () =>
        one(GitEventRow, "update git_events set status = 'running' where id = (select id from git_events where status = 'pending' order by created_at, id limit 1 for update skip locked) returning *", []),
      async finish(id, status) {
        if (!isId(id)) return;
        await pool.query("update git_events set status = $2, finished_at = case when $2 = 'pending' then null else now() end where id = $1 and status = 'running'", [id, status]);
      },
      async requestReconcile() {
        await pool.query("update git_reconcile set requested = true where not requested"); // no write, no row lock, when it is already asked for
      },
      takeReconcileRequest: async () => (await pool.query("update git_reconcile set requested = false where requested")).rowCount === 1,
      documentOrg: async (documentId) =>
        isId(documentId) ? (await one(z.object({ org_id: z.string() }), "select org_id from documents where id = $1", [documentId]))?.org_id : undefined,
      async recordConflict(documentId, input) {
        if (!isId(documentId)) return;
        const c = ConflictInput.parse(input);
        // Selected from documents: a document deleted meanwhile inserts nothing instead of failing on the foreign key.
        await pool.query(
          "insert into document_conflicts (document_id, commit_sha, file, reason, detail) select id, $2, $3, $4, $5 from documents where id = $1 " +
            "on conflict (document_id) do update set commit_sha = excluded.commit_sha, file = excluded.file, reason = excluded.reason, detail = excluded.detail, created_at = now()",
          [documentId, c.commit, c.file, c.reason, c.detail],
        );
      },
      async clearConflict(documentId) {
        if (isId(documentId)) await pool.query("delete from document_conflicts where document_id = $1", [documentId]);
      },
      shippedCommit: async (sha) => (await pool.query("select 1 from jobs where queue = 'ship' and output ->> 'commit' = $1 limit 1", [GitSha.parse(sha)])).rowCount === 1,
    }),

    getDocumentForMember: async (documentId, userId) =>
      isId(documentId) && isId(userId)
        ? one(DocumentRow, "select d.* from documents d join memberships m on m.org_id = d.org_id where d.id = $1 and m.user_id = $2", [documentId, userId])
        : undefined,

    forOrg(orgId) {
      /** A second statement, after any write: it reads the rows as they now are (a CTE would share the write's snapshot). */
      const coolingDown = async (documentId: string): Promise<boolean> =>
        (await one(
          z.object({ cooling: z.boolean() }),
          "select finished_at > now() - make_interval(secs => $3::float8 / 1000) as cooling from jobs " +
            "where org_id = $1 and document_id = $2 and queue = 'sandbox' and status in ('failed', 'cancelled') order by finished_at desc limit 1",
          [orgId, documentId, PREVIEW_RETRY_MS],
        ))?.cooling === true;
      const readPreview = async (documentId: string): Promise<Preview | undefined> => {
        const job = await one(PreviewRow, "select status, output from jobs where org_id = $1 and document_id = $2 and queue = 'sandbox' order by created_at desc, id desc limit 1", [orgId, documentId]);
        if (job) return job;
        return (await one(z.object({ id: z.string() }), "select id from documents where org_id = $1 and id = $2", [orgId, documentId])) ? { status: "none", url: null } : undefined;
      };
      const newestShip = (documentId: string): Promise<Ship | undefined> =>
        one(ShipRow, "select * from jobs where org_id = $1 and document_id = $2 and queue = 'ship' order by created_at desc, id desc limit 1", [orgId, documentId]);
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
        cancelRun: async (documentId, id) => {
          if (!orgExists || !isId(documentId) || !isId(id)) return undefined;
          // ONE statement decides by the status it finds, so a claim at the same moment cannot slip
          // between "is it queued?" and "cancel it".
          const hit = await one(
            RunRow,
            "update jobs set cancel_requested_at = now(), status = case status when 'queued' then 'cancelled' else status end, " +
              "finished_at = case status when 'queued' then now() else finished_at end " +
              "where org_id = $1 and document_id = $2 and id = $3 and queue = 'ai' and status in ('queued', 'running') returning *",
            [orgId, documentId, id],
          );
          // Nothing to cancel: finished already, or someone else's cancel won this very moment. Either way
          // the answer is the run as it NOW is, which takes a second statement: inside the first one (a CTE
          // was tried) the read shares the update's snapshot and shows the row as it was before the winner
          // committed. The loser was told "queued" about a run that was already cancelled.
          return hit ?? one(RunRow, "select * from jobs where org_id = $1 and document_id = $2 and id = $3 and queue = 'ai'", [orgId, documentId, id]);
        },
        usage: async (input) => {
          const none = { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
          if (!orgExists) return { totals: none, items: [], nextCursor: null };
          const items = await page(UsageRow, "usage t", "t.org_id = $1", [orgId], input);
          if (!items) return undefined;
          const totals = await exactlyOne(
            UsageTotalsRow,
            "select count(*)::text as runs, coalesce(sum(input_tokens), 0)::text as input_tokens, coalesce(sum(output_tokens), 0)::text as output_tokens, coalesce(sum(cache_read_tokens), 0)::text as cache_read_tokens, " +
              "coalesce(sum(cache_write_tokens), 0)::text as cache_write_tokens, coalesce(sum(cost_usd), 0)::text as cost_usd from usage where org_id = $1",
            [orgId],
          );
          return { totals, ...items };
        },
        openPreview: async ({ documentId, createdBy }) => {
          if (!orgExists || !isId(documentId) || (createdBy !== undefined && !isId(createdBy))) return undefined;
          // `on conflict do nothing`: the document's unfinished job, if any, is the answer as it is.
          // The per-org cap is a count inside the insert, and two counts read at the same instant both
          // pass it: opens of one org take turns on an advisory lock, and each insert, a statement of its
          // own after the lock, reads what the one before it committed (read committed).
          const inserted = await inOrgTurn(
            orgId,
            "insert into jobs (org_id, document_id, queue, input, created_by) select d.org_id, d.id, 'sandbox', '{}', $3 from documents d " +
              "where d.org_id = $1 and d.id = $2 and (select count(*) from jobs where org_id = $1 and queue = 'sandbox' and status in ('queued', 'running') and document_id <> $2) < $4 " +
              // Not again straight after a failure: the canvas asks once a second, and a sandbox that cannot
              // start at all would otherwise leave one row per second behind it.
              "and not exists (select 1 from jobs where org_id = $1 and document_id = $2 and queue = 'sandbox' " +
              "and status in ('failed', 'cancelled') and finished_at > now() - make_interval(secs => $5::float8 / 1000)) " +
              "on conflict do nothing returning id",
            [orgId, documentId, createdBy ?? null, MAX_PREVIEWS_PER_ORG, PREVIEW_RETRY_MS],
          );
          const preview = await readPreview(documentId);
          if (!preview) return undefined;
          const created = inserted[0] ? { queue: "sandbox" as const, jobId: inserted[0].id, orgId } : undefined;
          // Nothing inserted, nothing unfinished, and not merely waiting out the retry pause: the cap said no.
          if (!created && preview.status !== "queued" && preview.status !== "running" && !(await coolingDown(documentId))) return "busy";
          return { preview, created };
        },
        getPreview: async (documentId) => (orgExists && isId(documentId) ? readPreview(documentId) : undefined),
        async getConflict(documentId) {
          if (!orgExists || !isId(documentId)) return undefined;
          // The document's org decides whether there is an answer at all; the conflict row, whether it is null.
          const found = await rows(ConflictRow, "select c.* from documents d left join document_conflicts c on c.document_id = d.id where d.org_id = $1 and d.id = $2", [orgId, documentId]);
          return found.length === 0 ? undefined : found[0] ?? null;
        },
        startShip: async ({ documentId, createdBy }) => {
          if (!orgExists || !isId(documentId) || (createdBy !== undefined && !isId(createdBy))) return undefined;
          // `on conflict do nothing`: a ship already waiting for this document is the answer (jobs_one_queued_ship_per_document).
          const inserted = await one(
            z.object({ id: z.string() }),
            "insert into jobs (org_id, document_id, queue, input, created_by) select d.org_id, d.id, 'ship', '{}', $3 from documents d where d.org_id = $1 and d.id = $2 on conflict do nothing returning id",
            [orgId, documentId, createdBy ?? null],
          );
          // A second statement, so it sees the winner's commit. Not "the queued one": it may have been claimed in
          // between, and then it is running and has not read the document before this press. None: no such document.
          const ship = await newestShip(documentId);
          return ship && { ship, created: inserted ? { queue: "ship" as const, jobId: inserted.id, orgId } : undefined };
        },
        async getShip(documentId) {
          if (!orgExists || !isId(documentId)) return undefined;
          const ship = await newestShip(documentId);
          if (ship) return ship;
          return (await one(z.object({ id: z.string() }), "select id from documents where org_id = $1 and id = $2", [orgId, documentId])) ? null : undefined;
        },
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
