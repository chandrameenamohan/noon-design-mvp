import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { AuditEntry, Conflict, CreateRunBody, Doc, Document, FailureReason, Id, IdempotencyKey, Member, Name, Org, Preview, PreviewOutput, Role, Run, RunProgress, SandboxUrl, SequencedOp, ShareBody, Ship, ShipOutput, UsageAmount, UsageReport, User, Workspace, type Page } from "@noon/contracts";
import { z } from "zod";
import { LONGEST_WINDOW_SECONDS, Rule, verdict, type Verdict } from "./limit.ts";

export { Rule } from "./limit.ts";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Everything that can be done without naming an org. Deliberately tiny. */
export type Db = {
  migrate(): Promise<void>;
  appliedMigrations(): Promise<string[]>;
  /** Finds the user with this email or creates one. Emails are compared case-insensitively. */
  upsertUser(input: { email: string; name: string }): Promise<User>;
  /** E8.1: a new user with a password, in one statement. "taken": the email belongs to someone (with or without a password). */
  signUp(input: { email: string; name: string; passwordHash: string }): Promise<User | "taken">;
  /** The user with this email and their password hash; undefined when there is none, or they have no password. */
  credentialsFor(email: string): Promise<{ user: User; passwordHash: string } | undefined>;
  /**
   * Records a signed-in browser by the SHA-256 of its token, and forgets this user's sessions that have expired. The
   * same statement writes the sign-in into the audit trail of every org the user is a member of (F26).
   */
  startSession(input: { userId: string; tokenHash: Buffer; ttlSeconds: number }): Promise<void>;
  /** Who holds this session, if it exists and has not expired. A pure READ: asked on every request. */
  userForSession(tokenHash: Buffer): Promise<User | undefined>;
  /** Signs a browser out: the row goes, so the token stops working on the very next request. */
  endSession(tokenHash: Buffer): Promise<void>;
  /** Creates the org and makes `ownerId` its owner, atomically: an org never exists without an owner. */
  createOrg(input: { name: string; ownerId: string }): Promise<Org>;
  listOrgsFor(userId: string, page?: PageInput): Promise<Page<Org> | undefined>;
  /** The org and this user's role in it, but only if they are a member. "Not a member" and "no such org" look the same. */
  getOrgForMember(orgId: string, userId: string): Promise<{ org: Org; role: Role } | undefined>;
  /**
   * The document and this user's role on it, but only if they are a member of its org or it is shared with them
   * (E8.3: the higher of the two). Used where the path names no org.
   */
  getDocumentForMember(documentId: string, userId: string): Promise<{ document: Document; role: Role } | undefined>;
  /**
   * E8.2 (F24): this user's role on the document, if it is `orgId`'s and they are a member of that org or it is shared
   * with them (E8.3); undefined otherwise. The sync server asks it when a peer joins and when an access change is announced.
   */
  roleIn(orgId: string, documentId: string, userId: string): Promise<Role | undefined>;
  /** Resolves if the database answers a query, rejects otherwise. */
  ping(): Promise<void>;
  /**
   * E9.5 (F31): one hit on `key` under `rule`, counted in Postgres so every api instance shares the count (limit.ts).
   * Rejects when the database is away: the caller decides whether that fails open or closed. E9.6's seam.
   */
  take(key: string, rule: Rule): Promise<Verdict>;
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

/**
 * `load` gives undefined when the document does not exist IN THAT ORG. `snapshotSeq` is the newest snapshot
 * in MinIO (0: none yet). `doc` and `seq` are what F8's idle save wrote before E6.2 (`doc` undefined: nothing):
 * a document opens from whichever of the two is newer.
 */
export type DocumentStore = {
  load(orgId: string, documentId: string): Promise<{ doc: Doc | undefined; seq: number; snapshotSeq: number } | undefined>;
  /** E6.2: a snapshot at `seq` is stored. Called only AFTER the object is written; never moves backwards. */
  snapshotted(orgId: string, documentId: string, seq: number): Promise<void>;
  /** E7.3: the largest lease token that ever claimed this document (0: none); undefined when there is no such document. */
  fence(orgId: string, documentId: string): Promise<number | undefined>;
  /**
   * E7.3: this opening of the room, under lease `token`, becomes the document's only writer: from now on only
   * appends that carry `claim` land. False: a claim with an equal or larger token was made (this lease is stale).
   */
  claim(orgId: string, documentId: string, token: number, claim: string): Promise<boolean>;
  /**
   * E6.1a: journals an accepted op, BEFORE anyone hears of it. Undefined: written. An op: this sender's
   * opId was journaled already, and that is what it became (a resend the room had forgotten). Rejects
   * when the op is not durable: the database is away, the seq is taken (a second writer), the document is gone,
   * or (E7.3) `claim` is no longer the document's: `Fenced`. No claim: only a document never claimed takes it.
   */
  append(orgId: string, documentId: string, op: SequencedOp, claim?: string): Promise<SequencedOp | undefined>;
  /** What this sender's opId became, if it was ever journaled. */
  find(orgId: string, documentId: string, actorId: string, opId: string): Promise<SequencedOp | undefined>;
  /** Was this node id ever added to the document (keystone 4: a removed id is never added again)? */
  everAdded(orgId: string, documentId: string, nodeId: string): Promise<boolean>;
  /** The journaled ops after `seq`, in order: what the saved document does not hold yet. */
  since(orgId: string, documentId: string, seq: number): Promise<SequencedOp[]>;
};

/** E7.3: the append was refused because a newer owner claimed the document. This room must stop writing. */
export class Fenced extends Error {}

const QUEUES = ["ai", "sandbox", "ship"] as const;
/** `attempt`: the claim a worker holds (claim() returns it). Given, a write lands only while that claim is the job's latest. */
type JobKey = { queue: (typeof QUEUES)[number]; jobId: string; orgId: string; attempt?: number | undefined };
/** A job as the worker sees it. `input` is whatever the creating route validated and stored. */
export type Job = { id: string; orgId: string; documentId: string; queue: JobKey["queue"]; input: Record<string, unknown>; /** Undefined once that user has been deleted. */ createdBy: string | undefined };
type JobStore = {
  /**
   * queued -> running, atomically, as the job's next `attempt` (1 for the first). Undefined when there is nothing to
   * claim: unknown, already claimed, finished, or a job of ANOTHER queue.
   */
  claim(key: JobKey): Promise<(Job & { attempt: number }) | undefined>;
  /** running -> a terminal status. `reason` is what the user will read: anything that is not a plain name is stored as `internal`. */
  finish(key: JobKey, status: "succeeded" | "failed" | "cancelled", reason?: string): Promise<void>;
  /** The oldest jobs still waiting, across ALL orgs: what the worker offers to the queue again. */
  queued(limit: number): Promise<JobKey[]>;
  /**
   * "Still alive", from the worker running this attempt, once a second (F28), and the answer to "has someone asked
   * you to stop?" (F10). `lost`: the job is not this attempt's any more (finished, or given to another worker
   * after this one went silent): stop, and write nothing.
   */
  heartbeat(key: JobKey & { attempt: number }): Promise<"running" | "cancel" | "lost">;
  /**
   * Running jobs, across ALL orgs, whose heartbeat is older than `staleMs`: their worker died. Each goes back to
   * `queued` for another attempt, or, after `maxAttempts` claims, fails as `worker_lost` (one whose cancel was asked
   * for ends `cancelled`). `lost` counts both kinds of ending. A running ship with a
   * ship already waiting for its document fails too (the waiting one ships everything, and two may not wait).
   */
  requeueStale(staleMs: number, maxAttempts: number): Promise<{ requeued: number; lost: number }>;
  /**
   * What this job consumed, against ITS org (taken from the row; a key under another org writes nothing). Once per
   * job, by the key's `attempt` only while that attempt holds the job (a given-up attempt bills nothing).
   */
  recordUsage(key: JobKey, amount: UsageAmount): Promise<void>;
  /**
   * What a RUNNING job has to say before it ends: a sandbox's preview URL (null while it restarts), a ship's
   * commit and pull request, an AI run's steps (F30). Validated by the key's queue; a job that is not running is left
   * as it is, and with an `attempt`, so is one another attempt now holds (a slow dead attempt's steps never show).
   */
  report(key: JobKey, output: PreviewOutput | ShipOutput | RunProgress | null): Promise<void>;
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
  /**
   * noon-wv8.3.1: the commit of the branch's newest done event, what the canvas was last brought up to. The git
   * peer diffs a push from it, so a push recorded by nobody (its delivery lost behind a later one) is not skipped.
   */
  lastDone(ref: string): Promise<string | undefined>;
  /**
   * The oldest waiting event -> running, as its next `attempt`. Waiting: pending, or (noon-91u) running with no
   * heartbeat for `staleMs` (its git peer died), which is resumed. One that died with its peer `maxResumes` times
   * fails instead. Two peers never claim one event: the database decides, in one statement. Undefined: none.
   */
  claim(staleMs: number, maxResumes: number): Promise<(GitEvent & { attempt: number }) | undefined>;
  /** "Still working on it", from the peer holding this attempt. False: another peer has resumed it (or it ended): stop. */
  heartbeat(event: { id: string; attempt: number }): Promise<boolean>;
  /**
   * Ends a running event. `pending` hands it back: Gitea was away, and the event must not be lost over it. Only
   * while the event is still this attempt's: a slow peer, given up on, ends nothing.
   */
  finish(event: { id: string; attempt: number }, status: "done" | "failed" | "pending"): Promise<void>;
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
  /**
   * noon-91u: the node ids a commit already added to a document, from the journal (git's add_node ops stamped with
   * it): what a push applied again must not take for re-used ids, nor add twice.
   */
  pushedNodeIds(documentId: string, commit: string): Promise<Set<string>>;
};
// The same rules the table's checks hold, parsed BEFORE the write: a bad value is a caller's bug, named here.
const GitSha = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
const GitEventInput = z.object({ ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/), before: GitSha, after: GitSha, deliveryId: z.string().regex(/^[\x21-\x7e]{1,100}$/).optional() });
// `detail` is parse's words about a file an engineer wrote: capped here, not refused (the conflict must still be shown).
const ConflictInput = Conflict.omit({ at: true, detail: true }).extend({ detail: z.string().transform((d) => d.slice(0, 300)) });
const GitEventRow = z.object({ id: z.string(), ref: z.string(), before_sha: z.string(), after_sha: z.string(), attempts: z.number().int() })
  .transform((r): GitEvent & { attempt: number } => ({ id: r.id, ref: r.ref, before: r.before_sha, after: r.after_sha, attempt: r.attempts }));

type PageInput = { limit?: number; cursor?: string | undefined };

type OrgScope = {
  /**
   * E8.2 (F24): makes the user with this email a member at `role`, or changes their role. "no_user": nobody has
   * that email. "last_owner": it would leave the org without an owner. "forbidden": `by` is no longer an owner here
   * (demoted after the route checked). One change at a time per org.
   */
  setMember(input: { email: string; role: Role; by: string | undefined }): Promise<Member | "no_user" | "last_owner" | "forbidden">;
  /** E10.8: one page of this org's members with their roles, oldest first (the founding owner leads). Undefined = a bad cursor. */
  listMembers(page?: PageInput): Promise<Page<Member> | undefined>;
  /** E10.8: one page of the shares of this org's document, oldest first. Undefined = a bad cursor; a document not this org's has none. */
  listShares(documentId: string, page?: PageInput): Promise<Page<Member> | undefined>;
  /**
   * E8.3 (F25): shares this org's document with the user with this email, or changes their share. Undefined: no such user
   * (or document). "below_org_role": they are a member of the org at a higher role than `role`, which would be the role
   * in effect (accessOf takes the higher), so the share is refused rather than answered with a role they would not have.
   */
  share(input: { documentId: string; email: string; role: ShareRole; by: string | undefined }): Promise<Member | "below_org_role" | undefined>;
  /** E8.3: the share goes. False: there was none. */
  unshare(documentId: string, userId: string, by: string | undefined): Promise<boolean>;
  createWorkspace(input: { name: string }): Promise<Workspace>;
  /** Undefined means the cursor is not one this server issued. */
  listWorkspaces(page?: PageInput): Promise<Page<Workspace> | undefined>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  /** Undefined when the workspace does not exist in THIS org. */
  createDocument(input: { workspaceId: string; title: string }): Promise<Document | undefined>;
  listDocuments(workspaceId: string, page?: PageInput): Promise<Page<Document> | undefined>;
  getDocument(id: string): Promise<Document | undefined>;
  /**
   * Undefined when the document does not exist in THIS org; "busy" when it already has an unfinished run. The run starts as `queued`.
   * F27: with an `idempotencyKey` (and a `createdBy`, its scope), the same key again answers the run it made, as that row
   * now is; "key_reused" when that key asked for something else.
   * F31: with a `limit`, the run is one hit on the org's AI run limit, in the SAME transaction as the insert: over it,
   * `{ retryAfterSeconds }` and no run. Only a run that is made is counted (busy, gone, over the limit: rolled back), and
   * a replayed key is answered with its run without a hit, so a retry is never refused for the run it already made.
   */
  createRun(input: { documentId: string; instruction: string; createdBy: string | undefined; idempotencyKey?: string | undefined; limit?: Rule | undefined }): Promise<Run | "busy" | "key_reused" | { retryAfterSeconds: number } | undefined>;
  getRun(documentId: string, id: string): Promise<Run | undefined>;
  /** F30: the document's newest run (what a reloaded page picks up); null when it never had one, undefined when there is no such document in THIS org. */
  getLatestRun(documentId: string): Promise<Run | null | undefined>;
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
   * the document does not exist in THIS org. F27: with an `idempotencyKey`, the same key again answers the ship that
   * press made or joined (created: undefined), as that row now is; "key_reused" when that key asked for something else.
   */
  startShip(input: { documentId: string; createdBy: string | undefined; idempotencyKey?: string | undefined }): Promise<{ ship: Ship; created: JobKey | undefined } | "key_reused" | undefined>;
  /** The document's newest ship; null: never shipped. Undefined when the document does not exist in THIS org. */
  getShip(documentId: string): Promise<Ship | null | undefined>;
  /** Queued: cancelled at once. Running: marked, and the worker ends it. Finished: unchanged. Always the run as it now is. */
  cancelRun(documentId: string, id: string): Promise<Run | undefined>;
  /** Everything this org has consumed: totals, per user, per UTC day, and one page of the runs, newest first, from one snapshot. Undefined = a bad cursor. */
  usage(page?: PageInput): Promise<UsageReport | undefined>;
  /** E8.4 (F26): one page of this org's audit trail, newest first. Undefined = a bad cursor. Nothing here changes an entry. */
  audit(page?: PageInput): Promise<Page<AuditEntry> | undefined>;
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

type ShareRole = z.infer<typeof ShareBody>["role"];
/**
 * E8.3: the role of user `$<n>` on document `d`: their role in its org or their share of it, whichever is higher; null
 * when they have neither. A scalar subquery: still one round trip per request (the E1.4 finding), two primary-key probes.
 */
const accessOf = (userParam: string): string =>
  "(select role from (select role from memberships where org_id = d.org_id and user_id = " + userParam +
  " union all select role from document_shares where document_id = d.id and user_id = " + userParam +
  ") a order by array_position(array['viewer', 'editor', 'owner'], role) desc limit 1)";

const MemberRow = z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string() })
  .transform((r): Member => Member.parse({ userId: r.id, email: r.email, name: r.name, role: r.role }));

// E8.4 (F26): every audited action inserts into audit_log IN ITS OWN STATEMENT (a CTE) or transaction, never after it.
const AUDIT_COLUMNS = "(org_id, actor_kind, actor_id, actor_email, action, document_id, detail)";
/** The actor columns for the user id in parameter `p` (null: the system acted), with their email as it is now. */
const actorOf = (p: string): string =>
  `case when ${p}::uuid is null then 'system' else 'user' end, ${p}::uuid, (select email from users where id = ${p}::uuid)`;
const AuditRow = z
  .object({ id: z.string(), org_id: z.string(), actor_kind: z.string(), actor_id: z.string().nullable(), actor_email: z.string().nullable(), action: z.string(), document_id: z.string().nullable(), detail: z.unknown(), created_at: timestamp })
  .transform((r): AuditEntry =>
    AuditEntry.parse({ id: r.id, orgId: r.org_id, actor: { kind: r.actor_kind, id: r.actor_id, email: r.actor_email }, action: r.action, documentId: r.document_id, detail: r.detail, at: r.created_at }));

// seq is a bigint: a string from the driver, a number from here on.
const JournalRow = z
  .object({ seq: z.string().regex(/^\d+$/).transform(Number), op_id: z.string(), actor_kind: z.string(), actor_id: z.string(), run_id: z.string().nullable(), op: z.unknown() })
  .transform((r): SequencedOp => SequencedOp.parse({ seq: r.seq, opId: r.op_id, actor: { kind: r.actor_kind, id: r.actor_id, ...(r.run_id === null ? {} : { runId: r.run_id }) }, op: r.op }));
const JOURNAL_COLUMNS = "seq, op_id, actor_kind, actor_id, run_id, op";

// A left join from the document: no conflict row = every column null.
const ConflictRow = z.object({ commit_sha: z.string().nullable(), file: z.string().nullable(), reason: z.string().nullable(), detail: z.string().nullable(), created_at: z.date().nullable() })
  .transform((r): Conflict | null => (r.commit_sha === null ? null : Conflict.parse({ commit: r.commit_sha, file: r.file, reason: r.reason, detail: r.detail, at: r.created_at?.toISOString() })));
const nullableTimestamp = z.date().nullable().transform((d) => d?.toISOString() ?? null);
// A run's progress is written by our own worker but quotes the model: read as untrusted, and a row that does not parse shows no steps.
const RunRow = z
  .object({ id: z.string(), org_id: z.string(), document_id: z.string(), status: z.string(), input: z.object({ instruction: z.string() }), error: z.string().nullable(), output: z.unknown(), created_at: timestamp, started_at: nullableTimestamp, finished_at: nullableTimestamp })
  .transform((r): Run => {
    const progress = RunProgress.safeParse(r.output);
    return Run.parse({ id: r.id, orgId: r.org_id, documentId: r.document_id, status: r.status, instruction: r.input.instruction, error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, steps: progress.success ? progress.data.steps : [] });
  });
// bigint and numeric arrive as STRINGS from the driver (learning-tests/postgres): converted once, here.
// Safe because UsageAmount caps what may be WRITTEN at Number.MAX_SAFE_INTEGER, so no stored token count
// (and no sum of them worth reading) leaves the range a JS number holds exactly.
const count = z.string().regex(/^\d+$/).transform(Number);
const money = z.string().regex(/^\d+(\.\d+)?$/).transform(Number);
const UsageRow = z
  .object({ id: z.string(), org_id: z.string(), job_id: z.string().nullable(), document_id: z.string().nullable(), user_id: z.string().nullable(), email: z.string().nullable(), kind: z.string(), model: z.string(), input_tokens: count, output_tokens: count, cache_read_tokens: count, cache_write_tokens: count, cost_usd: money, created_at: timestamp })
  .transform((r): UsageReport["items"][number] =>
    UsageReport.shape.items.element.parse({ id: r.id, orgId: r.org_id, runId: r.job_id, documentId: r.document_id, userId: r.user_id, email: r.email, kind: r.kind, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: r.cost_usd, createdAt: r.created_at }));
/** The sums every part of the usage report shares, as text (bigint and numeric sums arrive as strings anyway). */
const USAGE_SUMS =
  "count(*)::text as runs, coalesce(sum(input_tokens), 0)::text as input_tokens, coalesce(sum(output_tokens), 0)::text as output_tokens, " +
  "coalesce(sum(cache_read_tokens), 0)::text as cache_read_tokens, coalesce(sum(cache_write_tokens), 0)::text as cache_write_tokens, coalesce(sum(cost_usd), 0)::text as cost_usd";
const UsageSums = z.object({ runs: count, input_tokens: count, output_tokens: count, cache_read_tokens: count, cache_write_tokens: count, cost_usd: money });
const sumsOf = (r: z.infer<typeof UsageSums>): UsageReport["totals"] => ({ runs: r.runs, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: r.cost_usd });
const UsageTotalsRow = UsageSums.transform(sumsOf);
const UsageUserRow = UsageSums.extend({ user_id: z.string().nullable(), email: z.string().nullable() })
  .transform((r): UsageReport["byUser"][number] => UsageReport.shape.byUser.element.parse({ ...sumsOf(r), userId: r.user_id, email: r.email }));
const UsageDayRow = UsageSums.extend({ day: z.string() }).transform((r): UsageReport["byDay"][number] => UsageReport.shape.byDay.element.parse({ ...sumsOf(r), day: r.day }));
/** How many users and days the usage report lists. ponytail: a cap, not paging; ceiling: an org with more users than this sees its most expensive 100. */
const USAGE_USERS = 100;
const USAGE_DAYS = 31;
const JobRow = z
  .object({ id: z.string(), org_id: z.string(), document_id: z.string(), queue: z.enum(QUEUES), input: z.record(z.string(), z.unknown()), created_by: z.string().nullable(), attempts: z.number().int() })
  .transform((r): Job & { attempt: number } => ({ id: r.id, orgId: r.org_id, documentId: r.document_id, queue: r.queue, input: r.input, createdBy: r.created_by ?? undefined, attempt: r.attempts }));

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

  /** `via`: a client inside a transaction; the pool otherwise. */
  async function rows<T>(parser: z.ZodType<T>, sql: string, params: unknown[], via: Pool | PoolClient = pool): Promise<T[]> {
    const result = await via.query<QueryResultRow>(sql, params);
    return result.rows.map((row) => parser.parse(row));
  }
  /** `from` names the paged table as alias `t`; `where` must be ready for " and ..."; the cursor adds two params. */
  async function page<T>(parser: z.ZodType<T>, from: string, where: string, params: unknown[], input: PageInput = {}, newestFirst = false, via: Pool | PoolClient = pool): Promise<Page<T> | undefined> {
    const limit = input.limit ?? 50;
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (input.cursor !== undefined && after === undefined) return undefined;
    const n = params.length;
    const result = await via.query<QueryResultRow & { cursor_ts: string; id: string }>(
      `select t.*, t.created_at::text as cursor_ts from ${from} where ${where}` +
        (after ? ` and (t.created_at, t.id) ${newestFirst ? "<" : ">"} ($${String(n + 1)}::timestamptz, $${String(n + 2)}::uuid)` : "") +
        (newestFirst ? " order by t.created_at desc, t.id desc" : " order by t.created_at, t.id") +
        ` limit ${String(limit + 1)}`, // one extra row tells us whether another page exists
      after ? [...params, after.ts, after.id] : params,
    );
    const pageRows = result.rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => parser.parse(row)),
      nextCursor: result.rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  }
  /** `work` in one transaction, committed only when `keep` says so (rolled back otherwise, as on a throw). */
  async function inTx<T>(work: (client: PoolClient) => Promise<T>, keep: (result: T) => boolean = () => true, begin = "begin"): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query(keep(result) ? "commit" : "rollback");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      broken = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      client.release(broken); // after a failure the connection's transaction state is unknown: destroyed
    }
  }
  /** `work` in one transaction that holds the advisory lock named `lock`: whatever else takes that lock waits its turn. */
  const inTurn = <T>(lock: string, work: (client: PoolClient) => Promise<T>): Promise<T> =>
    inTx(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [lock]);
      return work(client);
    });
  /**
   * One hit on a rate limit (limit.ts). `greatest`: a hit that computed its window just before the boundary but reached
   * the row after one computed just past it must not move the row back a window (and reset its count).
   * `win` is the second the window began, not its index (noon-elo.5.1): an index counts in units of one window length,
   * so after a rule's window grew every stored index would outrank every new one and a key over its limit would never
   * reset. A start is comparable across lengths: the count resets at the first of the rule's windows to begin after it.
   * noon-elo.7.2: each hit also deletes up to two OTHER keys' rows whose window began over a day ago (ended, whatever
   * their rule: a deleted row and a reset count are the same thing). A hit adds at most one row and removes up to two
   * ended ones, so ended rows never pile up however many keys a client mints. `skip locked`: two hits never wait on, or
   * both delete, one row; not this key's own row, which the upsert below is writing. `now()`, not `clock_timestamp()`:
   * stable, so the rate_limits_win index (migration 0022) can serve it. ponytail: pruning rides the traffic,
   * so a quiet table keeps its ended rows (harmless: they reset on their next hit); upgrade: a worker sweep if it matters.
   */
  async function take(key: string, rule: Rule, via: Pool | PoolClient = pool): Promise<Verdict> {
    const { windowSeconds } = Rule.parse(rule);
    const hit = await one(
      z.object({ hits: z.number().int(), win: count, now: z.number() }),
      "with ended as (delete from rate_limits where key in (select key from rate_limits where win < (extract(epoch from now()) - $3)::bigint " +
        "and key <> $1 order by win limit 2 for update skip locked)) " +
        "insert into rate_limits as r (key, win, hits) values ($1, (floor(extract(epoch from clock_timestamp()) / $2) * $2)::bigint, 1) " +
        "on conflict (key) do update set hits = case when r.win >= excluded.win then r.hits + 1 else 1 end, win = greatest(r.win, excluded.win) " +
        "returning hits, win::text, extract(epoch from clock_timestamp())::float8 as now",
      [z.string().min(1).max(200).parse(key), windowSeconds, LONGEST_WINDOW_SECONDS],
      via,
    );
    if (!hit) throw new Error("rate limit: no row");
    return verdict({ hits: hit.hits, window: hit.win, now: hit.now }, rule);
  }
  /** One statement, returning ids, holding the org's preview lock: one at a time per org. */
  const inOrgTurn = (orgId: string, sql: string, params: unknown[]): Promise<{ id: string }[]> =>
    inTurn(`noon:preview:${orgId}`, async (client) => (await client.query<QueryResultRow>(sql, params)).rows.map((row) => z.object({ id: z.string() }).parse(row)));
  async function one<T>(parser: z.ZodType<T>, sql: string, params: unknown[], via: Pool | PoolClient = pool): Promise<T | undefined> {
    return (await rows(parser, sql, params, via))[0];
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

    take: (key, rule) => take(key, rule),

    upsertUser: async ({ email, name }) =>
      exactlyOne(
        UserRow,
        // "do update" (a no-op write) rather than "do nothing", so RETURNING yields the row either way.
        "insert into users (email, name) values (lower($1), $2) on conflict (email) do update set email = excluded.email returning id, email, name",
        [User.shape.email.parse(email), Name.parse(name)],
      ),

    signUp: async ({ email, name, passwordHash }) =>
      (await one(
        UserRow,
        // One statement: a user never exists without the password they signed up with, and two sign-ups of one
        // email race on the unique key, where exactly one wins.
        "with u as (insert into users (email, name) values (lower($1), $2) on conflict (email) do nothing returning id, email, name), " +
          "c as (insert into credentials (user_id, password_hash) select id, $3 from u) select * from u",
        [User.shape.email.parse(email), Name.parse(name), passwordHash],
      )) ?? "taken",

    credentialsFor: async (email) =>
      one(
        z.object({ id: z.string(), email: z.string(), name: z.string(), password_hash: z.string() }).transform((r) => ({ user: User.parse({ id: r.id, email: r.email, name: r.name }), passwordHash: r.password_hash })),
        "select u.id, u.email, u.name, c.password_hash from users u join credentials c on c.user_id = u.id where u.email = lower($1)",
        [email],
      ),

    startSession: async ({ userId, tokenHash, ttlSeconds }) => {
      if (!isId(userId)) throw new Error("cannot start a session: invalid user id");
      await pool.query(
        // ponytail: expired rows are swept at the owner's next sign-in; ceiling: someone who never signs in again
        // keeps dead rows; upgrade: a periodic delete by expires_at.
        "with gone as (delete from auth_sessions where user_id = $1 and expires_at <= now()), " +
          "s as (insert into auth_sessions (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(secs => $3)) returning user_id) " +
          // One row per org, not one global row: an org's trail shows its members' sign-ins, and nobody else's.
          `insert into audit_log ${AUDIT_COLUMNS} select m.org_id, 'user', u.id, u.email, 'signed_in', null, '{}' from s join users u on u.id = s.user_id join memberships m on m.user_id = u.id`,
        [userId, tokenHash, ttlSeconds],
      );
    },

    userForSession: async (tokenHash) =>
      one(UserRow, "select u.id, u.email, u.name from auth_sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()", [tokenHash]),

    endSession: async (tokenHash) => {
      await pool.query("delete from auth_sessions where token_hash = $1", [tokenHash]);
    },

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
        ? one(z.looseObject({ role: Role }).transform((r) => ({ org: OrgRow.parse(r), role: r.role })), "select o.*, m.role from orgs o join memberships m on m.org_id = o.id where o.id = $1 and m.user_id = $2", [orgId, userId])
        : undefined,

    documentStore: () => ({
      async load(orgId, documentId) {
        if (!isId(orgId) || !isId(documentId)) return undefined;
        const row = await one(
          // seq is a bigint, which the driver hands over as a STRING (learning-tests/postgres): convert
          // once, here. A document would need nine quadrillion ops to leave Number's safe range.
          z.object({ content: z.unknown(), seq: count, snapshot_seq: count }),
          "select content, seq, snapshot_seq from documents where org_id = $1 and id = $2",
          [orgId, documentId],
        );
        if (!row) return undefined;
        return { doc: row.content === null ? undefined : Doc.parse(row.content), seq: row.seq, snapshotSeq: row.snapshot_seq };
      },
      async snapshotted(orgId, documentId, seq) {
        if (!isId(orgId) || !isId(documentId)) return;
        // `< $3`: a slow write of an older snapshot must never point the document back at it.
        await pool.query("update documents set snapshot_seq = $3 where org_id = $1 and id = $2 and snapshot_seq < $3", [orgId, documentId, seq]);
      },
      async fence(orgId, documentId) {
        if (!isId(orgId) || !isId(documentId)) return undefined;
        return (await one(z.object({ fence_token: count }), "select fence_token from documents where org_id = $1 and id = $2", [orgId, documentId]))?.fence_token;
      },
      async claim(orgId, documentId, token, claim) {
        if (!isId(orgId) || !isId(documentId) || !isId(claim)) return false;
        // `<`, not `<=`: two openings under one token (a flushed Redis issuing it again) cannot both claim.
        const claimed = await pool.query("update documents set fence_token = $3, fence_claim = $4 where org_id = $1 and id = $2 and fence_token < $3", [orgId, documentId, token, claim]);
        return claimed.rowCount === 1;
      },
      async append(orgId, documentId, { seq, opId, actor, op }, claim) {
        if (!isId(orgId) || !isId(documentId)) throw new Error("journal: not a document id");
        try {
          // From the document's row, so that a document of another org (or one deleted meanwhile) takes no op.
          // The fence is in the same statement (F22): the row must still name this room's claim, and FOR UPDATE
          // locks it, so a claim either waits for this insert (and its reader sees the row) or comes first (and
          // Postgres re-checks the WHERE against the claimed row: nothing is inserted). Never read-then-write.
          const written = await pool.query(
            `insert into op_journal (document_id, org_id, ${JOURNAL_COLUMNS}) select id, org_id, $3, $4, $5, $6, $7, $8 from documents where org_id = $1 and id = $2 and fence_claim is not distinct from $9 for update`,
            [orgId, documentId, seq, opId, actor.kind, actor.id, actor.runId ?? null, JSON.stringify(op), claim ?? null],
          );
          if (written.rowCount !== 1) {
            // Only telling the two refusals apart, after the fact: nothing was written either way.
            const exists = await pool.query("select 1 from documents where org_id = $1 and id = $2", [orgId, documentId]);
            throw exists.rowCount === 1 ? new Fenced("journal: fenced, a newer owner claimed the document") : new Error("journal: the document is gone");
          }
          return undefined;
        } catch (err) {
          // Two unique keys, told apart by NAME: 23505 alone cannot say whether this is a resend or a rival writer.
          if (err instanceof Error && "constraint" in err && err.constraint === "op_journal_op") {
            const original = await one(JournalRow, `select ${JOURNAL_COLUMNS} from op_journal where document_id = $1 and actor_id = $2 and op_id = $3`, [documentId, actor.id, opId]);
            if (original) return original;
          }
          throw err;
        }
      },
      find: async (orgId, documentId, actorId, opId) =>
        isId(orgId) && isId(documentId) && isId(opId)
          ? one(JournalRow, `select ${JOURNAL_COLUMNS} from op_journal where org_id = $1 and document_id = $2 and actor_id = $3 and op_id = $4`, [orgId, documentId, actorId, opId])
          : undefined,
      async everAdded(orgId, documentId, nodeId) {
        if (!isId(orgId) || !isId(documentId)) return false;
        // Spelled as the partial index op_journal_added is, so that it is used.
        const found = await pool.query("select 1 from op_journal where document_id = $2 and org_id = $1 and op ->> 'type' = 'add_node' and op ->> 'nodeId' = $3 limit 1", [orgId, documentId, nodeId]);
        return found.rowCount === 1;
      },
      // ponytail: every row after the snapshot, in one read. Ceiling: a room that crashed long after its last
      // snapshot opens slowly (10,000 rows open in well under 2 s, F19). Upgrade: stream the rows in pages.
      since: async (orgId, documentId, seq) =>
        isId(orgId) && isId(documentId)
          ? rows(JournalRow, `select ${JOURNAL_COLUMNS} from op_journal where org_id = $1 and document_id = $2 and seq > $3 order by seq`, [orgId, documentId, seq])
          : [],
    }),

    jobStore: () => ({
      // `queue = $3`: the message says which queue it came from, the ROW says which queue the job is
      // on, and they must agree BEFORE anything is written. Without it, a message on the ai queue that
      // names a git job would mark it running and then fail to parse it: running for ever.
      claim: async ({ queue, jobId, orgId }) =>
        isId(jobId) && isId(orgId)
          ? one(JobRow, "update jobs set status = 'running', started_at = now(), heartbeat_at = now(), attempts = attempts + 1 where org_id = $1 and id = $2 and queue = $3 and status = 'queued' returning *", [orgId, jobId, queue])
          : undefined,
      async finish({ jobId, orgId, attempt }, status, reason) {
        if (!isId(jobId) || !isId(orgId)) return;
        // `status = 'running'`: a finished job stays finished, whoever reports late. `attempts`: a worker that went
        // silent, was given up on and woke up later does not end the attempt another worker is running now.
        await pool.query("update jobs set status = $3, error = $4, finished_at = now() where org_id = $1 and id = $2 and status = 'running' and ($5::int is null or attempts = $5)", [
          orgId, jobId, status, status === "failed" ? (FailureReason.safeParse(reason).success ? reason : "internal") : null, attempt ?? null,
        ]);
      },
      async heartbeat({ jobId, orgId, attempt }) {
        if (!isId(jobId) || !isId(orgId)) return "lost";
        const beat = await one(
          z.object({ cancel: z.boolean() }),
          "update jobs set heartbeat_at = now() where org_id = $1 and id = $2 and status = 'running' and attempts = $3 returning cancel_requested_at is not null as cancel",
          [orgId, jobId, attempt],
        );
        return beat === undefined ? "lost" : beat.cancel ? "cancel" : "running";
      },
      async requeueStale(staleMs, maxAttempts) {
        // ONE statement, `skip locked`: every worker process sweeps, and two sweeps never both take a row.
        // coalesce(heartbeat_at, started_at): a row left running by a worker from before heartbeats (0019) is stale too.
        // `distinct on`: of the ships of one document that went silent together, only the newest may wait again
        // (0011: one waiting ship per document); it reads the document afresh, so it ships what they would have.
        // A job someone asked to stop is not run again: it ends as `cancelled` (F10), as its worker would have ended it.
        // A sandbox's address dies with its worker (the next attempt reports one); a ship's commit stays, as the git
        // peer asks it "did Ship push this?" (E5.5), and the push may still be on its way. An AI run's steps are the
        // dead attempt's (F30): the next attempt starts its list afresh, so a reload never shows steps nobody is taking.
        const counted = await one(
          z.object({ requeued: z.number().int(), lost: z.number().int() }),
          `with stale as (
             select id, queue, document_id, attempts, created_at, cancel_requested_at is not null as cancel from jobs
             where status = 'running' and coalesce(heartbeat_at, started_at) < now() - make_interval(secs => $1::float8 / 1000)
             for update skip locked),
           again as (
             select distinct on (case when queue = 'ship' then document_id else id end) id from stale s
             where not cancel and attempts < $2 and not (queue = 'ship' and exists (select 1 from jobs w where w.queue = 'ship' and w.status = 'queued' and w.document_id = s.document_id))
             order by case when queue = 'ship' then document_id else id end, created_at desc),
           requeued as (
             update jobs set status = 'queued', started_at = null, heartbeat_at = null, output = case when queue in ('sandbox', 'ai') then null else output end
             where id in (select id from again) returning 1),
           lost as (
             update jobs set status = case when stale.cancel then 'cancelled' else 'failed' end, error = case when stale.cancel then null else 'worker_lost' end, finished_at = now()
             from stale where jobs.id = stale.id and stale.id not in (select id from again) returning 1)
           select (select count(*) from requeued)::int as requeued, (select count(*) from lost)::int as lost`,
          [staleMs, maxAttempts],
        );
        return counted ?? { requeued: 0, lost: 0 };
      },
      async recordUsage({ jobId, orgId, attempt }, amount) {
        if (!isId(jobId) || !isId(orgId)) return;
        const a = UsageAmount.parse(amount); // the same contract the reader uses, BEFORE the write
        // insert ... select FROM THE JOB: org, document and user are what the row says, never what a caller
        // says, and a key that names the job under another org selects nothing. `on conflict`: billed once.
        // Billed once, so by the attempt that holds the job (noon-elo.2.4): `attempts` as finish() fences it, and not
        // `queued` (given away, the next claim not yet made). A given-up attempt's spend is ours, not the org's; the
        // job's LAST attempt bills even when the sweep ended it (worker_lost, cancelled).
        await pool.query(
          "insert into usage (org_id, job_id, document_id, user_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) " +
            "select j.org_id, j.id, j.document_id, j.created_by, 'ai_run', $3, $4, $5, $6, $7, $8 from jobs j where j.org_id = $1 and j.id = $2 " +
            "and ($9::int is null or (j.attempts = $9 and j.status <> 'queued')) on conflict (job_id) do nothing",
          [orgId, jobId, a.model, a.inputTokens, a.outputTokens, a.cacheReadTokens, a.cacheWriteTokens, a.costUsd.toFixed(6), attempt ?? null],
        );
      },
      queued: (limit) =>
        rows(
          z.object({ id: z.string(), org_id: z.string(), queue: z.enum(QUEUES) }).transform((r) => ({ queue: r.queue, jobId: r.id, orgId: r.org_id })),
          // Only the queues this code knows: the day `git` jobs exist, one of them must not stop the sweep for every org.
          "select id, org_id, queue from jobs where status = 'queued' and queue = any($2) order by created_at, id limit $1",
          [limit, QUEUES],
        ),
      async report({ queue, jobId, orgId, attempt }, output) {
        const valid = (queue === "ship" ? ShipOutput : queue === "ai" ? RunProgress : PreviewOutput).nullable().parse(output); // the contract the reader will use, BEFORE the write
        if (!isId(jobId) || !isId(orgId)) return;
        const commit = valid !== null && "commit" in valid ? valid.commit : null;
        // noon-91u, a ship's commit is never lost: (1) it goes into ship_commits whatever the job's state (a slow attempt's
        // push may still be on its way, and the git peer must know it is Ship's); (2) a retried ship that found nothing
        // new to commit (null) keeps the commit its earlier attempt showed, instead of wiping it.
        await pool.query(
          `with c as (insert into ship_commits (commit_sha, job_id) select $5, id from jobs where org_id = $1 and id = $2 and queue = 'ship' and $5::text is not null on conflict do nothing)
           update jobs set output = case when queue = 'ship' and jsonb_typeof($3::jsonb) = 'object' and $3::jsonb -> 'commit' = 'null' and output ->> 'commit' is not null
             then jsonb_set($3::jsonb, '{commit}', output -> 'commit') else $3::jsonb end
           where org_id = $1 and id = $2 and status = 'running' and ($4::int is null or attempts = $4)`,
          [orgId, jobId, JSON.stringify(valid), attempt ?? null, commit],
        );
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
      lastDone: async (ref) =>
        (await one(z.object({ after_sha: z.string() }), "select after_sha from git_events where ref = $1 and status = 'done' order by created_at desc, id desc limit 1", [ref]))?.after_sha,
      async claim(staleMs, maxResumes) {
        // coalesce(heartbeat_at, created_at): a row left running by a peer from before heartbeats (0021) is stale too.
        const stale = "status = 'running' and coalesce(heartbeat_at, created_at) < now() - make_interval(secs => $1::float8 / 1000)";
        // An event that took its peer down every time must end, or it would take every peer down in turn.
        await pool.query(`update git_events set status = 'failed', finished_at = now() where ${stale} and resumes >= $2`, [staleMs, maxResumes]);
        // ONE statement, `skip locked`: two peers never claim one event, and neither waits for the other. The row is
        // locked and its WHERE checked again on the newest version (read committed), so a stale event another peer
        // has just resumed (fresh heartbeat) is skipped, never resumed twice. `status` on the right is the OLD one.
        return one(
          GitEventRow,
          `update git_events set status = 'running', heartbeat_at = now(), attempts = attempts + 1, resumes = resumes + (status = 'running')::int
           where id = (select id from git_events where status = 'pending' or (${stale} and resumes < $2) order by created_at, id limit 1 for update skip locked) returning *`,
          [staleMs, maxResumes],
        );
      },
      heartbeat: async ({ id, attempt }) =>
        isId(id) && (await pool.query("update git_events set heartbeat_at = now() where id = $1 and status = 'running' and attempts = $2", [id, attempt])).rowCount === 1,
      async finish({ id, attempt }, status) {
        if (!isId(id)) return;
        await pool.query("update git_events set status = $2, finished_at = case when $2 = 'pending' then null else now() end where id = $1 and status = 'running' and attempts = $3", [id, status, attempt]);
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
        // The rejected push goes into the document's org's audit trail in the same statement (F26). ponytail: the actor
        // is "git" and the commit, not the person who pushed; ceiling: the trail cannot name them; upgrade: keep the
        // webhook's pusher on git_events and copy it here.
        await pool.query(
          "with c as (insert into document_conflicts (document_id, commit_sha, file, reason, detail) select id, $2, $3, $4, $5 from documents where id = $1 " +
            "on conflict (document_id) do update set commit_sha = excluded.commit_sha, file = excluded.file, reason = excluded.reason, detail = excluded.detail, created_at = now() returning document_id) " +
            `insert into audit_log ${AUDIT_COLUMNS} select d.org_id, 'git', null, null, 'push_rejected', d.id, jsonb_build_object('commit', $2::text, 'file', $3::text, 'reason', $4::text) from c join documents d on d.id = c.document_id`,
          [documentId, c.commit, c.file, c.reason, c.detail],
        );
      },
      async clearConflict(documentId) {
        if (isId(documentId)) await pool.query("delete from document_conflicts where document_id = $1", [documentId]);
      },
      shippedCommit: async (sha) => (await pool.query("select 1 from ship_commits where commit_sha = $1", [GitSha.parse(sha)])).rowCount === 1,
      pushedNodeIds: async (documentId, commit) =>
        new Set(isId(documentId)
          ? await rows(
            z.object({ id: z.string() }).transform((r) => r.id),
            // op_journal_added: the document's adds alone are read, and of those the ones this commit sent.
            "select op ->> 'nodeId' as id from op_journal where document_id = $1 and op ->> 'type' = 'add_node' and actor_kind = 'git' and run_id = $2",
            [documentId, GitSha.parse(commit)],
          )
          : []),
    }),

    getDocumentForMember: async (documentId, userId) =>
      isId(documentId) && isId(userId)
        ? one(z.looseObject({ role: Role }).transform((r) => ({ document: DocumentRow.parse(r), role: r.role })), `select * from (select d.*, ${accessOf("$2")} as role from documents d where d.id = $1) x where role is not null`, [documentId, userId])
        : undefined,

    roleIn: async (orgId, documentId, userId) =>
      isId(orgId) && isId(documentId) && isId(userId)
        ? (await one(z.object({ role: Role.nullable() }), `select ${accessOf("$3")} as role from documents d where d.org_id = $1 and d.id = $2`, [orgId, documentId, userId]))?.role ?? undefined
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
      const newestShip = (documentId: string, via: Pool | PoolClient = pool): Promise<Ship | undefined> =>
        one(ShipRow, "select * from jobs where org_id = $1 and document_id = $2 and queue = 'ship' order by created_at desc, id desc limit 1", [orgId, documentId], via);
      /** A press of Ship: the waiting ship is made, or joined (`created` undefined). */
      const pressShip = async (documentId: string, createdBy: string | undefined, via: Pool | PoolClient): Promise<{ ship: Ship; created: JobKey | undefined } | undefined> => {
        // `on conflict do nothing`: a ship already waiting for this document is the answer (jobs_one_queued_ship_per_document).
        const inserted = await one(
          z.object({ id: z.string() }),
          // Audited only when this press made the ship: one that joins the waiting ship changes nothing.
          "with j as (insert into jobs (org_id, document_id, queue, input, created_by) select d.org_id, d.id, 'ship', '{}', $3 from documents d where d.org_id = $1 and d.id = $2 on conflict do nothing returning id, org_id, document_id, created_by), " +
            `a as (insert into audit_log ${AUDIT_COLUMNS} select j.org_id, ${actorOf("j.created_by")}, 'ship_started', j.document_id, jsonb_build_object('ship', j.id::text) from j) ` +
            "select id from j",
          [orgId, documentId, createdBy ?? null],
          via,
        );
        // A second statement, so it sees the winner's commit. Not "the queued one": it may have been claimed in
        // between, and then it is running and has not read the document before this press. None: no such document.
        const ship = await newestShip(documentId, via);
        return ship && { ship, created: inserted ? { queue: "ship" as const, jobId: inserted.id, orgId } : undefined };
      };
      /**
       * F27: `make` runs in a transaction that first claims (this user, `key`) in this org. A second request with the key
       * waits on that row, then is answered with the job the first one made: `{ replay }` (its id), never a second job.
       * "key_reused": the key was claimed for a different request. When `make` made no job (busy, no such document) the
       * claim is rolled back, and the retry that follows is free to use the key. Keys live 24 hours (migration 0018).
       */
      const withKey = async <T>(userId: string, key: string, request: object, make: (via: PoolClient) => Promise<T>, jobOf: (made: T) => string | undefined): Promise<{ made: T } | { replay: string } | "key_reused"> => {
        const params = [orgId, userId, IdempotencyKey.parse(key), JSON.stringify(request)];
        const client = await pool.connect();
        let broken: Error | undefined;
        try {
          await client.query("begin");
          await client.query("delete from idempotency_keys where org_id = $1 and user_id = $2 and created_at < now() - interval '24 hours'", params.slice(0, 2));
          if ((await client.query("insert into idempotency_keys (org_id, user_id, key, request) values ($1, $2, $3, $4) on conflict do nothing", params)).rowCount !== 1) {
            // A statement of its own, so it sees the winner's row, committed while the insert waited on it (read committed).
            const found = await one(z.object({ same: z.boolean(), job_id: z.string() }), "select request = $4::jsonb as same, job_id from idempotency_keys where org_id = $1 and user_id = $2 and key = $3", params, client);
            await client.query("commit");
            if (!found) throw new Error("idempotency key held by nobody");
            return found.same ? { replay: found.job_id } : "key_reused";
          }
          const made = await make(client);
          const jobId = jobOf(made);
          if (jobId === undefined) {
            await client.query("rollback");
            return { made };
          }
          await client.query("update idempotency_keys set job_id = $4 where org_id = $1 and user_id = $2 and key = $3", [...params.slice(0, 3), jobId]);
          await client.query("commit");
          return { made };
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          broken = err instanceof Error ? err : new Error(String(err));
          throw err;
        } finally {
          client.release(broken);
        }
      };
      /** One statement: the run, if the document is this org's and has no unfinished run, and its audit row. */
      const insertRun = async (documentId: string, input: z.infer<typeof CreateRunBody>, createdBy: string | undefined, via: Pool | PoolClient): Promise<Run | "busy" | undefined> => {
        try {
          return await one(
            RunRow,
            // insert ... select: the row is only created if the document exists in this org. Audited in the same statement.
            "with j as (insert into jobs (org_id, document_id, queue, input, created_by) select d.org_id, d.id, 'ai', $3, $4 from documents d where d.org_id = $1 and d.id = $2 returning *), " +
              `a as (insert into audit_log ${AUDIT_COLUMNS} select j.org_id, ${actorOf("j.created_by")}, 'run_started', j.document_id, jsonb_build_object('run', j.id::text, 'instruction', j.input ->> 'instruction') from j) ` +
              "select * from j",
            [orgId, documentId, JSON.stringify(input), createdBy ?? null],
            via,
          );
        } catch (err) {
          // The unique index IS the check: "count, then insert" would let two requests at the same moment both in.
          if (err instanceof Error && "constraint" in err && err.constraint === "jobs_one_unfinished_run_per_document") return "busy";
          throw err;
        }
      };
      // An id that is not a UUID cannot name anything, so it means "not found" rather than a
      // Postgres 22P02 error (which would surface as a 500 and echo the caller's input).
      const orgExists = isId(orgId);
      return {
        setMember: async ({ email, role, by }) => {
          if (!orgExists || (by !== undefined && !isId(by))) throw new Error("cannot set a member: invalid org or actor id");
          const input = { email: User.shape.email.parse(email), role: Role.parse(role) };
          // One change at a time per org: two owners demoting each other at once must not both see the other
          // still an owner (under read committed, each statement would) and leave the org with none. The actor's own role
          // is read again under the lock: the route's check ran before it, and an owner demoted since must not act.
          return inTurn(`noon:members:${orgId}`, async (client) => {
            const found = z.object({ id: z.string(), role: Role.nullable(), owners: count, actor: Role.nullable() }).optional().parse((await client.query<QueryResultRow>(
              "select u.id, m.role, (select count(*) from memberships where org_id = $1 and role = 'owner') as owners, " +
                "(select role from memberships where org_id = $1 and user_id = $3) as actor " +
                "from users u left join memberships m on m.user_id = u.id and m.org_id = $1 where u.email = lower($2)",
              [orgId, input.email, by ?? null],
            )).rows[0]);
            if (!found) return "no_user";
            if (by !== undefined && found.actor !== "owner") return "forbidden";
            if (found.role === "owner" && input.role !== "owner" && found.owners <= 1) return "last_owner";
            const member = MemberRow.parse((await client.query<QueryResultRow>(
              "with m as (insert into memberships (org_id, user_id, role) values ($1, $2, $3) on conflict (org_id, user_id) do update set role = excluded.role returning user_id, role) " +
                "select u.id, u.email, u.name, m.role from m join users u on u.id = m.user_id",
              [orgId, found.id, input.role],
            )).rows[0]);
            // In the same transaction (F26). Setting the role someone already has changes nothing, and is not recorded.
            if (found.role !== input.role) {
              await client.query(
                `insert into audit_log ${AUDIT_COLUMNS} select $1, ${actorOf("$2")}, 'role_changed', null, jsonb_build_object('email', $3::text, 'role', $4::text, 'previous', $5::text)`,
                [orgId, by ?? null, member.email, member.role, found.role ?? "none"],
              );
            }
            return member;
          });
        },
        // Both lists page over a join given to page() as the table `t`: its keyset is (created_at, id), and here `id` is the
        // user's, unique within one org's memberships and within one document's shares. The org (and the document) is in the
        // WHERE: a list never reaches past the tenant the route already proved the caller may see.
        listMembers: async (input) =>
          orgExists
            ? page(MemberRow, "(select m.org_id, m.role, m.created_at, u.id, u.email, u.name from memberships m join users u on u.id = m.user_id) t", "t.org_id = $1", [orgId], input)
            : { items: [], nextCursor: null },
        listShares: async (documentId, input) =>
          orgExists && isId(documentId)
            ? page(MemberRow, "(select s.org_id, s.document_id, s.role, s.created_at, u.id, u.email, u.name from document_shares s join users u on u.id = s.user_id) t", "t.org_id = $1 and t.document_id = $2", [orgId, documentId], input)
            : { items: [], nextCursor: null },
        share: async ({ documentId, email, role, by }) => {
          const input = ShareBody.parse({ email, role });
          if (!orgExists || !isId(documentId) || (by !== undefined && !isId(by))) return undefined;
          const row = await one(
            z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string().nullable() }),
            // insert ... select: a row only when the document is this org's and the user exists, and is not a member of the
            // org at a higher role than the share's (noon-dtf.3.3); audited in the same statement. `t` is found either way,
            // so no row is "no such user" and a null role is "refused".
            "with t as (select d.org_id, d.id as document_id, u.id as user_id, u.email, u.name from documents d, users u where d.org_id = $1 and d.id = $2 and u.email = lower($3)), " +
              "s as (insert into document_shares (org_id, document_id, user_id, role) select t.org_id, t.document_id, t.user_id, $4 from t " +
              "where not exists (select 1 from memberships m where m.org_id = t.org_id and m.user_id = t.user_id and " +
              "array_position(array['viewer', 'editor', 'owner'], m.role) > array_position(array['viewer', 'editor', 'owner'], $4::text)) " +
              "on conflict (document_id, user_id) do update set role = excluded.role returning user_id, role), " +
              `a as (insert into audit_log ${AUDIT_COLUMNS} select $1, ${actorOf("$5")}, 'share_granted', $2, jsonb_build_object('email', u.email, 'role', s.role) from s join users u on u.id = s.user_id) ` +
              "select t.user_id as id, t.email, t.name, s.role from t left join s on s.user_id = t.user_id",
            [orgId, documentId, input.email, input.role, by ?? null],
          );
          if (!row) return undefined;
          return row.role === null ? "below_org_role" : MemberRow.parse(row);
        },
        unshare: async (documentId, userId, by) =>
          orgExists && isId(documentId) && isId(userId) && (by === undefined || isId(by)) &&
          (await pool.query(
            // The audit row is inserted FROM the deleted row: no share, no row, and the count says which.
            `with d as (delete from document_shares where org_id = $1 and document_id = $2 and user_id = $3 returning org_id, document_id, user_id) ` +
              `insert into audit_log ${AUDIT_COLUMNS} select d.org_id, ${actorOf("$4")}, 'share_revoked', d.document_id, jsonb_build_object('email', u.email) from d join users u on u.id = d.user_id`,
            [orgId, documentId, userId, by ?? null],
          )).rowCount === 1,
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
        createRun: async ({ documentId, instruction, createdBy, idempotencyKey, limit }) => {
          const input = CreateRunBody.parse({ instruction }); // the same contract the reader uses, BEFORE the write
          if (!orgExists || !isId(documentId) || (createdBy !== undefined && !isId(createdBy))) return undefined;
          // F31: the hit first, then the run, in one transaction that commits only if the run was made. The hit holds the
          // org's counter row until then, so an org's run starts take turns (for the length of one insert).
          const make = async (via: PoolClient): Promise<Run | "busy" | { retryAfterSeconds: number } | undefined> => {
            const allowed = limit === undefined ? ({ ok: true } as const) : await take(`ai_run:${orgId}`, limit, via);
            return allowed.ok ? insertRun(documentId, input, createdBy, via) : { retryAfterSeconds: allowed.retryAfterSeconds };
          };
          const made = (run: Awaited<ReturnType<typeof make>>): string | undefined => (typeof run === "object" && "id" in run ? run.id : undefined);
          if (idempotencyKey === undefined) return inTx(make, (run) => made(run) !== undefined);
          if (createdBy === undefined) throw new Error("an idempotency key needs the user it belongs to");
          const keyed = await withKey(createdBy, idempotencyKey, { queue: "ai", documentId, input }, make, made);
          if (keyed === "key_reused") return keyed;
          return "made" in keyed ? keyed.made : one(RunRow, "select * from jobs where org_id = $1 and id = $2 and queue = 'ai'", [orgId, keyed.replay]);
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
          if (!orgExists) return { totals: none, byUser: [], byDay: [], items: [], nextCursor: null };
          // One REPEATABLE READ snapshot for every part (the E3.4 finding): a run recorded between two of these reads
          // would otherwise show in the totals and not in the items. Read only: nothing here may write.
          return inTx(async (client) => {
            // The user's email as it is now; a deleted user's runs keep their cost, and show no one.
            const items = await page(UsageRow, "(select usage.*, users.email from usage left join users on users.id = usage.user_id) t", "t.org_id = $1", [orgId], input, true, client);
            if (!items) return undefined;
            const totals = await one(UsageTotalsRow, `select ${USAGE_SUMS} from usage where org_id = $1`, [orgId], client);
            const byUser = await rows(
              UsageUserRow,
              `select s.*, users.email from (select user_id, ${USAGE_SUMS}, sum(cost_usd) as cost from usage where org_id = $1 group by user_id) s ` +
                "left join users on users.id = s.user_id order by s.cost desc, users.email nulls last limit $2",
              [orgId, USAGE_USERS],
              client,
            );
            const byDay = await rows(
              UsageDayRow,
              `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, ${USAGE_SUMS} from usage where org_id = $1 group by 1 order by 1 desc limit $2`,
              [orgId, USAGE_DAYS],
              client,
            );
            return { totals: totals ?? none, byUser, byDay, ...items };
          }, () => true, "begin transaction isolation level repeatable read read only");
        },
        audit: async (input) => (orgExists ? page(AuditRow, "audit_log t", "t.org_id = $1", [orgId], input, true) : { items: [], nextCursor: null }),
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
        startShip: async ({ documentId, createdBy, idempotencyKey }) => {
          if (!orgExists || !isId(documentId) || (createdBy !== undefined && !isId(createdBy))) return undefined;
          if (idempotencyKey === undefined) return pressShip(documentId, createdBy, pool);
          if (createdBy === undefined) throw new Error("an idempotency key needs the user it belongs to");
          const keyed = await withKey(createdBy, idempotencyKey, { queue: "ship", documentId, input: {} }, (via) => pressShip(documentId, createdBy, via), (started) => started?.ship.id);
          if (keyed === "key_reused") return keyed;
          if ("made" in keyed) return keyed.made;
          const ship = await one(ShipRow, "select * from jobs where org_id = $1 and id = $2 and queue = 'ship'", [orgId, keyed.replay]);
          return ship && { ship, created: undefined };
        },
        async getShip(documentId) {
          if (!orgExists || !isId(documentId)) return undefined;
          const ship = await newestShip(documentId);
          if (ship) return ship;
          return (await one(z.object({ id: z.string() }), "select id from documents where org_id = $1 and id = $2", [orgId, documentId])) ? null : undefined;
        },
        async getLatestRun(documentId) {
          if (!orgExists || !isId(documentId)) return undefined;
          const run = await one(RunRow, "select * from jobs where org_id = $1 and document_id = $2 and queue = 'ai' order by created_at desc, id desc limit 1", [orgId, documentId]);
          if (run) return run;
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
    // F26: the app may add to the audit trail and read it, never change or remove it (the table's trigger refuses
    // everyone else). Revoked AFTER the grant above, on every provisioning: a deploy restores it if anyone widened it.
    await owner.query(`revoke update, delete, truncate on ${s}.audit_log from ${r}`);

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
