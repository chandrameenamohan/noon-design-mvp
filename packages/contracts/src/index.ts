import { z } from "zod";

/** Body of GET /health. The first contract: one schema, one inferred type. */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponse>;

export const Id = z.uuid();
/**
 * Trimmed, 1-200 characters, no control characters. Used on the way IN (before a write) and on the
 * way out. Control characters are refused here because Postgres text cannot hold a NUL byte: without
 * this, a body that satisfies the contract would still fail in the database as a 500.
 */
export const Name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\P{Cc}*$/u, "must not contain control characters");
const Timestamp = z.iso.datetime();

export const User = z.object({ id: Id, email: z.email().max(320), name: Name });
export type User = z.infer<typeof User>;

export const Org = z.object({ id: Id, name: Name, createdAt: Timestamp });
export type Org = z.infer<typeof Org>;

export const Workspace = z.object({ id: Id, orgId: Id, name: Name, createdAt: Timestamp });
export type Workspace = z.infer<typeof Workspace>;

export const Document = z.object({ id: Id, orgId: Id, workspaceId: Id, title: Name, createdAt: Timestamp });
export type Document = z.infer<typeof Document>;

// --- Roles (F24) -------------------------------------------------------------------
/** A member's role in an org. A viewer reads everything and changes nothing; only an owner changes roles. */
export const Role = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof Role>;
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
/** Does `role` include everything `need` may do? The roles are nested: owner > editor > viewer. */
export const includes = (role: Role, need: Role): boolean => RANK[role] >= RANK[need];
/** GET /orgs/:orgId: the org, and the caller's own role in it (the screens show an owner's controls by it; the api decides regardless). */
export const OrgAsMember = Org.extend({ role: Role });
export type OrgAsMember = z.infer<typeof OrgAsMember>;
export const Member = z.object({ userId: Id, email: User.shape.email, name: Name, role: Role });
export type Member = z.infer<typeof Member>;
/**
 * E10.8: one page of GET /orgs/:orgId/members (every member, oldest first) or of GET /documents/:id/shares (the
 * document's shares, owners only: a share names someone outside the org). A share is a Member whose role is never owner.
 */
export const MemberPage = z.strictObject({ items: z.array(Member), nextCursor: z.string().nullable() });
export type MemberPage = z.infer<typeof MemberPage>;

// --- HTTP bodies -------------------------------------------------------------
// --- Sign-in (F23) ----------------------------------------------------------------
/**
 * What a person calls themselves, shown to everyone in the document (presence). Stricter than `Name`: format
 * characters (a right-to-left override, zero-width joiners) and stacks of combining marks let one name pass for
 * another. Cosmetic, never privilege (actor ids decide), but a person's name should read as what it is.
 */
const DisplayName = Name.refine((name) => !/\p{Cf}/u.test(name), "must not contain invisible formatting characters").refine((name) => !/\p{M}{3}/u.test(name), "must not stack combining marks");
/** 8 to 128 characters (NIST 800-63B: a floor, no composition rules; the cap bounds the work one request can ask of the hash). */
const Password = z.string().min(8, "must be at least 8 characters").max(128, "must be at most 128 characters");
export const SignUpBody = z.strictObject({ email: User.shape.email, name: DisplayName, password: Password });
/** Only the caps: a sign-in that breaks the sign-up rules is still just a wrong password, and says nothing more. */
export const SignInBody = z.strictObject({ email: z.string().max(320), password: z.string().max(128) });
/** GET /auth/me: who this browser is signed in as, or null. */
export const Me = z.object({ user: User.nullable() });
export type Me = z.infer<typeof Me>;

export const CreateOrgBody = z.strictObject({ name: Name });
export const CreateWorkspaceBody = z.strictObject({ name: Name });
export const CreateDocumentBody = z.strictObject({ title: Name });
/** PUT /orgs/:orgId/members: makes the user with this email a member at `role`, or changes their role. Owners only. */
export const SetMemberBody = z.strictObject({ email: User.shape.email, role: Role });
/**
 * PUT /documents/:id/shares (F25): shares ONE document with the user with this email, or changes their share. Never
 * `owner`: a share lets someone work on a document, never run the org. Owners of the document's org only.
 */
export const ShareBody = z.strictObject({ email: User.shape.email, role: z.enum(["editor", "viewer"]) });

// --- AI runs (F9) ----------------------------------------------------------------
/**
 * F27: the `Idempotency-Key` header of POST /documents/:id/runs and /ship. Optional; a retry with the same key gets
 * the same job. 1 to 255 printable ASCII characters (a UUID per press is what the canvas sends), as Stripe allows.
 */
export const IdempotencyKey = z.string().regex(/^[\x21-\x7e]{1,255}$/, "1 to 255 printable ASCII characters");
/** Newlines and tabs are fine in an instruction; other control characters are not (jsonb cannot hold NUL). */
const Instruction = z.string().trim().min(1).max(4000).regex(/^(?:\P{Cc}|[\n\t])*$/u, "must not contain control characters");
export const CreateRunBody = z.strictObject({ instruction: Instruction });
const RunStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
/** Why a run failed, as a NAME the UI turns into a sentence. Never an error message: those carry paths, request ids, prompt text. */
export const FailureReason = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/**
 * `error` is present exactly when the status is `failed`. `instruction` is a plain string on the way
 * OUT: if the input rule is ever tightened, the runs already stored must still be readable.
 */
/**
 * F30: one tool call of a run, as the panel lists it. `tool` is one of OUR tool names; `detail` comes from the
 * MODEL's arguments (a component name, a prop key, a node id): untrusted text, shown as text, never as markup.
 */
export const RunStep = z.strictObject({ tool: FailureReason, ok: z.boolean(), detail: z.string().max(80) });
export type RunStep = z.infer<typeof RunStep>;
/** Keeps the last this-many steps: a progress view, not a transcript (SPEC §6: no persisted full transcript). */
export const MAX_RUN_STEPS = 50;
/** What a running `ai` job reports (jobs.output): the steps of its CURRENT attempt only. */
export const RunProgress = z.strictObject({ steps: z.array(RunStep).max(MAX_RUN_STEPS) });
export type RunProgress = z.infer<typeof RunProgress>;
export const Run = z.object({
  id: Id, orgId: Id, documentId: Id, status: RunStatus, instruction: z.string(), error: FailureReason.nullable(),
  createdAt: Timestamp, startedAt: Timestamp.nullable(), finishedAt: Timestamp.nullable(),
  /** F30: what the run has done so far, oldest first; kept when it ends, so a reload afterwards still shows it. */
  steps: RunProgress.shape.steps,
});
export type Run = z.infer<typeof Run>;
/** GET /documents/:id/run: the document's newest run, or null when the AI was never asked. What a reloaded page picks up. */
export const DocumentRun = z.strictObject({ run: Run.nullable() });
export type DocumentRun = z.infer<typeof DocumentRun>;

/**
 * What a running `sandbox` job reports: where the document's preview answers. Only http(s): the
 * canvas puts this in an iframe's src, and a `javascript:` URL there runs in the canvas's origin.
 */
export const PreviewOutput = z.strictObject({ url: z.url({ protocol: /^https?$/u }) });
export type PreviewOutput = z.infer<typeof PreviewOutput>;
// `URL.canParse` first: Zod runs a refine even when the format check before it failed, and a
// `new URL()` that throws inside a refine makes safeParse THROW. A stored row must never be a 500.
const onLoopback = (url: string): boolean => URL.canParse(url) && new URL(url).hostname === "127.0.0.1";
/**
 * Where a sandbox answers, as the worker stores it: this machine's loopback, nowhere else. Every preview
 * is http://127.0.0.1:<the stack's sandbox proxy>/preview/<document>/<token>/ (noon-9gz), and a row that
 * said otherwise must never frame another site.
 */
export const SandboxUrl = PreviewOutput.shape.url.refine(onLoopback, "a preview answers on 127.0.0.1");
/**
 * A document's preview as the canvas reads it (F15): its newest sandbox job. `none` = never opened.
 * `url` is set only while the job runs and the sandbox answers; null while it (re)starts = "rebuilding".
 * The stored loopback address, or, when the app is reached through one public URL (noon-l96), the same
 * path on the canvas's own origin, which carries it as /preview/<document>/<token>/. That host is the
 * api's configuration, not the row's; the canvas frames only its own origin or the loopback.
 */
export const Preview = z.strictObject({
  status: z.enum(["none", ...RunStatus.options]),
  url: PreviewOutput.shape.url
    .refine((url) => onLoopback(url) || (URL.canParse(url) && /^\/preview\/[0-9a-f-]{36}\/[0-9a-f]{16}\.[0-9a-f]{32}\//u.test(new URL(url).pathname)), "a preview answers on 127.0.0.1, or under /preview/")
    .nullable(),
});
export type Preview = z.infer<typeof Preview>;

// --- Conflicts (F16b) ------------------------------------------------------------------------------
/**
 * Why a pushed generated page was not applied: codegen's parse reasons, push-ops' history checks, and the
 * git peer's own refusals of the file. The worker assigns its reasons to this type, so a reason added there
 * and not here stops compiling (and the canvas's Record of sentences stops compiling in turn).
 */
export const ConflictReason = z.enum([
  // codegen (generate's rules, applied to the parsed tree)
  "unknown_prop", "wrong_prop_type", "missing_required_prop", "malformed_doc", "unknown_component", "reserved_component", "parent_takes_no_children",
  // parse (the fixed shape)
  "too_large", "too_deep", "syntax_error", "extra_statement", "hook", "second_export", "not_page_component", "bad_import", "spread", "conditional", "map",
  "non_literal_prop", "text_child", "expression_child", "not_an_element", "missing_node_id", "bad_node_id", "duplicate_node_id", "duplicate_prop",
  // push-ops (the document's history)
  "root_mismatch", "reused_node_id", "component_changed",
  // the git peer (the file itself)
  "deleted", "not_a_file",
]);
export type ConflictReason = z.infer<typeof ConflictReason>;
/**
 * A push to the document's branch that changed nothing, as the canvas shows it (F16b). `commit` and `file`
 * come from an engineer's push: the canvas renders them as TEXT, never as markup. `detail` is parse's own
 * words (a line number, what it met), capped.
 */
export const Conflict = z.strictObject({
  commit: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/u),
  file: z.string().min(1).max(300),
  reason: ConflictReason,
  detail: z.string().max(300),
  at: z.iso.datetime(),
});
export type Conflict = z.infer<typeof Conflict>;
/** GET /documents/:id/conflict. null: the newest push to the document's branch was applied, or there was none. */
export const DocumentConflict = z.strictObject({ conflict: Conflict.nullable() });
export type DocumentConflict = z.infer<typeof DocumentConflict>;

// --- Ship (F17) ------------------------------------------------------------------------------------
/**
 * What a running `ship` job reports. `commit`: the commit THIS job made on the document's branch (null when the
 * branch already held the page as generated); the git peer skips it, as it is the document already. `pr`: the
 * open pull request, once found or opened. Its `url` goes into a link's href: http(s) only.
 */
export const ShipOutput = z.strictObject({
  commit: Conflict.shape.commit.nullable(),
  pr: z.strictObject({ number: z.number().int().positive(), url: z.url({ protocol: /^https?$/u }) }).nullable(),
});
export type ShipOutput = z.infer<typeof ShipOutput>;
/** A document's ship as the canvas reads it: a job, like a run. `error` is present exactly when it failed. */
export const Ship = z.strictObject({
  id: Id, documentId: Id, status: RunStatus, error: FailureReason.nullable(), commit: ShipOutput.shape.commit, pr: ShipOutput.shape.pr,
  createdAt: Timestamp, finishedAt: Timestamp.nullable(),
});
export type Ship = z.infer<typeof Ship>;
/** GET /documents/:id/ship: the newest ship, or null when the document was never shipped. */
export const DocumentShip = z.strictObject({ ship: Ship.nullable() });
export type DocumentShip = z.infer<typeof DocumentShip>;

// --- Usage (F12) -----------------------------------------------------------------------------------
// The upper bound is not taste: it is what the system BEHIND this schema can hold. Cost is a
// numeric(12,6) column, whose largest value is 999999.999999 and whose scale is a millionth of a dollar
// (a finer cost is rounded, not refused). Looser here means a run that worked and a row Postgres throws
// out afterwards: the work happens, the bookkeeping vanishes, and only stderr says so.
// Tokens need no such bound: a bigint is read back through a JS number, and Zod's .int() already
// refuses anything outside the safe integer range (measured), which is the narrower rule of the two.
const Tokens = z.number().int().min(0);
export const MAX_COST_USD = 999_999.999_999;
/** What one piece of work consumed. `costUsd` is the provider's ESTIMATE; under a subscription nothing is charged per run. */
export const UsageAmount = z.object({ model: z.string().min(1).max(100), inputTokens: Tokens, outputTokens: Tokens, cacheReadTokens: Tokens, cacheWriteTokens: Tokens, costUsd: z.number().min(0).max(MAX_COST_USD) });
export type UsageAmount = z.infer<typeof UsageAmount>;
/** Who ran it: null once that user is deleted. Their email as it is NOW (the usage row keeps only the id). */
const UsageUser = { userId: Id.nullable(), email: User.shape.email.nullable() };
/**
 * `runId` and `documentId` are null once the run or the document is gone: what was spent stays on record.
 * One record is one run (a run is billed once).
 */
const UsageRecord = UsageAmount.extend({ id: Id, orgId: Id, runId: Id.nullable(), documentId: Id.nullable(), ...UsageUser, kind: z.enum(["ai_run"]), createdAt: Timestamp });
const UsageSum = UsageAmount.omit({ model: true }).extend({ runs: Tokens });
/**
 * F31: GET /orgs/:orgId/usage. Totals over everything, the same per user (most expensive first) and per UTC day
 * (newest first, the latest 31 days that had any), and one page of the runs, newest first. All of it read from one
 * snapshot, so the parts always add up.
 */
export const UsageReport = z.object({
  totals: UsageSum,
  byUser: z.array(UsageSum.extend(UsageUser)),
  byDay: z.array(UsageSum.extend({ day: z.iso.date() })),
  items: z.array(UsageRecord),
  nextCursor: z.string().nullable(),
});
export type UsageReport = z.infer<typeof UsageReport>;

// --- Audit (F26) -----------------------------------------------------------------------------------
export const AuditAction = z.enum(["signed_in", "role_changed", "share_granted", "share_revoked", "run_started", "ship_started", "push_rejected"]);
export type AuditAction = z.infer<typeof AuditAction>;
/**
 * One row of an org's audit trail: who (a person, as their email was then; a push to git; the system), what (the
 * action, the document, and a few flat facts such as the new role or the run's instruction) and when. `detail` holds
 * what people typed (an instruction, a file name from a push): the view renders it as TEXT, never as markup.
 */
export const AuditEntry = z.strictObject({
  id: Id,
  orgId: Id,
  actor: z.strictObject({ kind: z.enum(["user", "git", "system"]), id: Id.nullable(), email: z.string().max(320).nullable() }),
  action: AuditAction,
  documentId: Id.nullable(),
  detail: z.record(z.string().max(40), z.string().max(4000)),
  at: Timestamp,
});
export type AuditEntry = z.infer<typeof AuditEntry>;
/** GET /orgs/:orgId/audit: one page, newest first. Owners only; there is no route that changes or removes an entry. */
export const AuditPage = z.strictObject({ items: z.array(AuditEntry), nextCursor: z.string().nullable() });
export type AuditPage = z.infer<typeof AuditPage>;

/** Every non-2xx response has this shape. `issues` names the failing fields of a rejected body. */
export const ErrorBody = z.object({
  error: z.enum(["invalid_json", "invalid_body", "invalid_query", "unsupported_media_type", "payload_too_large", "unauthenticated", "not_found", "forbidden", "last_owner", "share_below_org_role", "run_in_progress", "idempotency_key_reused", "preview_limit", "not_ready", "sync_unavailable", "email_taken", "invalid_credentials", "too_many_attempts", "rate_limited", "internal"]),
  issues: z.array(z.object({ field: z.string().min(1), message: z.string() })).optional(),
  /** With 429 rate_limited and too_many_attempts (F31): the same number as the Retry-After header, for a client that reads only the body. */
  retryAfterSeconds: z.number().int().min(1).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// --- Live editing session (F3) ---------------------------------------------------
/**
 * Where to open the WebSocket for a document, and the short-lived token that lets you in. `role` (E10.8): the caller's
 * role on the document as the api read it for THIS answer (org role or share, whichever is higher), so the editor can
 * show only the controls the person may use (Share is the owners'). A hint for the screen, never authority: the token
 * still carries no role (E1.5), every route and the room read the row for themselves, and a change reaches the screen at
 * the next session it mints. Optional: an api that predates it says nothing, and the editor shows nothing extra.
 */
export const SessionResponse = z.object({ wsUrl: z.url(), token: z.string().min(1), expiresAt: Timestamp, role: Role.optional() });
export type SessionResponse = z.infer<typeof SessionResponse>;

// --- Paging --------------------------------------------------------------------
// Every list is paged from the first version: adding it later would break every client.
export const PageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** `nextCursor` is opaque to clients: pass it back unchanged, or stop when it is null. */
export type Page<T> = { items: T[]; nextCursor: string | null };

// --- Component manifest (SPEC §2.7) ------------------------------------------------
// What the canvas may place and which props each component takes. GENERATED from the customer's
// TypeScript (packages/design-system), never written by hand, so it cannot drift from the code.
const PropType = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string") }),
  z.object({ kind: z.literal("number") }),
  z.object({ kind: z.literal("boolean") }),
  z.object({ kind: z.literal("enum"), options: z.array(z.string()).min(1) }),
]);

const ManifestProp = z.object({
  name: z.string().min(1),
  type: PropType,
  required: z.boolean(),
  /** The default the component applies when the prop is absent, if it declares one. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
const ManifestComponent = z.object({
  name: z.string().min(1),
  /** Whether other components may be placed inside it (it declares a `children` prop). */
  acceptsChildren: z.boolean(),
  props: z.array(ManifestProp),
});
export const Manifest = z.object({ version: z.literal(1), components: z.array(ManifestComponent) });
export type Manifest = z.infer<typeof Manifest>;

// --- The document and its four ops (SPEC §2.3, §2.6) ----------------------------------
// Ids and prop names become KEYS of plain objects. A key like "constructor" or "__proto__" would
// resolve through Object.prototype and look like a node that exists, so such names are refused here.
const notOnObjectPrototype = (key: string): boolean => !(key in Object.prototype);
const NodeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only")
  .refine(notOnObjectPrototype, "reserved name");
const PropKey = z.string().min(1).max(100).refine(notOnObjectPrototype, "reserved name");

/**
 * What a prop can hold. Matches what the manifest can describe: string, number, boolean (enums are
 * strings). Text may contain tabs and newlines but no other control characters: ops are stored as
 * jsonb, and Postgres cannot store NUL. Negative zero is refused because JSON writes it as 0, so
 * the sender (who keeps -0) and every other peer (who receives 0) would hold different documents.
 */
export const PropValue = z.union([
  z.string().max(10_000).regex(/^[^\p{Cc}]*$|^[\P{Cc}\t\n\r]*$/u, "must not contain control characters"),
  z.number().refine((n) => !Object.is(n, -0), "negative zero is not allowed"), // z.number() already refuses NaN and Infinity
  z.boolean(),
]);
export type PropValue = z.infer<typeof PropValue>;

const MAX_PROPS = 50;
const utf8 = new TextEncoder();
export const MAX_PROPS_BYTES = 32 * 1024; // UTF-8 bytes of the bag as JSON: what the socket counts
/**
 * A bag of props. NOT z.record(): the Agent SDK cannot convert z.record(k, v) and silently drops
 * every tool of the MCP server that uses it (SPEC §2a); this shape parses the same and converts.
 */
const Props = z
  // Zod quietly DROPS an own "__proto__" key while parsing. The sender would keep the prop and every
  // other peer would not, so the raw input is checked first and such a bag is refused outright.
  .unknown()
  .refine((raw) => !(typeof raw === "object" && raw !== null && Object.hasOwn(raw, "__proto__")), "reserved prop name")
  .pipe(z.object({}).catchall(PropValue))
  .refine((props) => Object.keys(props).length <= MAX_PROPS, `at most ${String(MAX_PROPS)} props`)
  // The sync server caps a frame at 64 KB before parsing it. Without this, an op that is valid here
  // could be impossible to send: the socket would close, the client would resend, for ever. Counted in
  // UTF-8 BYTES, as the socket counts: .length counts UTF-16 units, and a CJK character is 1 unit but 3
  // bytes (noon-3m1). TextEncoder, not Buffer: the browser imports this file too.
  .refine((props) => utf8.encode(JSON.stringify(props)).byteLength <= MAX_PROPS_BYTES, `props larger than ${String(MAX_PROPS_BYTES)} bytes`)
  .refine((props) => Object.keys(props).every((key) => PropKey.safeParse(key).success), "invalid prop name");

export const DocNode = z.object({
  id: NodeId,
  component: z.string().min(1).max(100),
  props: Props,
  parentId: NodeId.nullable(), // null only for the root
  children: z.array(NodeId),
});
export type DocNode = z.infer<typeof DocNode>;

/**
 * A page: a tree of component instances, stored flat by id so any node is one lookup away.
 * This schema checks each node's SHAPE only. Whether the nodes form a well-formed tree is
 * doc-model's checkDoc(), which whoever loads a document from outside must call (E2.3a, E6.2).
 */
export const Doc = z.object({ rootId: NodeId, nodes: z.record(NodeId, DocNode) });
export type Doc = z.infer<typeof Doc>;

/** The whole vocabulary of change. A discriminated union: `type` tells the compiler which fields exist. */
export const Op = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("add_node"), nodeId: NodeId, parentId: NodeId, index: z.number().int(), component: z.string().min(1).max(100), props: Props }),
  // `index` is the node's FINAL position among the new parent's children (SPEC §2.4).
  z.strictObject({ type: z.literal("move_node"), nodeId: NodeId, newParentId: NodeId, index: z.number().int() }),
  z.strictObject({ type: z.literal("remove_node"), nodeId: NodeId }),
  // value null = remove the prop, so the component's own default applies again.
  z.strictObject({ type: z.literal("set_prop"), nodeId: NodeId, key: PropKey, value: PropValue.nullable() }),
]);
export type Op = z.infer<typeof Op>;

/**
 * Why the room refuses an op. It is wire vocabulary, not an implementation detail: the CLIENT
 * decides what to show from it. "gone" is the one silent reason: the node (or the parent an add or
 * move targets) no longer exists, which is what a concurrent remove looks like. The user did nothing
 * wrong, so the op is dropped quietly; every other reason is shown to the sender (F5, F6).
 */
export const RejectReason = z.enum([
  "gone",
  "cycle",
  "duplicate_node",
  "root_is_fixed",
  "unknown_component",
  "parent_takes_no_children",
  "unknown_prop",
  "wrong_prop_type",
  "missing_required_prop",
  "document_limit", // the room caps node count and depth; a document cannot grow without bound
  // The room cannot tell whether this op was already applied: it is older than anything the room still
  // remembers (a long disconnect, or the room was reloaded). The client must resync, not resend.
  "stale",
  "unavailable", // the op could not be made durable, so it was not applied; safe to retry
  // This peer is sending faster than its budget. NOT applied. Wait `retryAfterMs`, then send this op
  // again and everything after it, in order: until then the room refuses this peer's later ops as well.
  "rate_limited",
  // F24: this peer may not edit the document (a viewer, or an AI run acting for one). NOT applied; sending it
  // again changes nothing until an owner changes the role.
  "forbidden",
]);
export type RejectReason = z.infer<typeof RejectReason>;

/** Who made a change. STAMPED BY THE ROOM from the verified session, never taken from the client. */
export const Actor = z.object({ kind: z.enum(["user", "agent", "git"]), id: z.string().min(1), runId: z.string().min(1).optional() });
export type Actor = z.infer<typeof Actor>;

/** What a peer submits. `opId` makes a resend harmless; `baseSeq` is the last seq the peer had seen. */
export const ClientOp = z.strictObject({ opId: z.uuid(), baseSeq: z.number().int().min(0), op: Op });
export type ClientOp = z.infer<typeof ClientOp>;

/** What the room broadcasts: the op, its place in the one true order, and who made it. */
export const SequencedOp = z.object({ seq: z.number().int().min(1), opId: z.uuid(), actor: Actor, op: Op });
export type SequencedOp = z.infer<typeof SequencedOp>;

// --- Presence: who else is here, where they point, what they have selected ---------------------
// Not an op: it is never put in order, never stored, and nothing about it survives a restart (F7).
/**
 * Where the pointer is, in the canvas's WORLD coordinates (E10.6): CSS px of the page frame at 100 %, origin
 * its top-left corner. Zoom and scroll are each window's own, so a cursor sent this way lands on the same
 * component in every window. Any spot on the infinite sheet counts (negative: left of or above the frame);
 * the bound only keeps a value that could never be a place on a page off the wire.
 */
const WORLD_LIMIT = 1_000_000;
const Cursor = z.strictObject({ x: z.number().min(-WORLD_LIMIT).max(WORLD_LIMIT), y: z.number().min(-WORLD_LIMIT).max(WORLD_LIMIT) });
const PresenceState = { cursor: Cursor.nullable(), selection: NodeId.nullable() };
/**
 * One CONNECTION's presence (a user with two tabs is here twice). `peerId` is minted by the room for
 * the connection; `actor` and `name` come from its verified session, never from a message.
 */
export const Presence = z.object({ peerId: z.string().min(1).max(100), actor: Actor, name: z.string().max(200), ...PresenceState });
export type Presence = z.infer<typeof Presence>;

// --- WebSocket messages ------------------------------------------------------------------------
export const ClientMessage = z.discriminatedUnion("type", [
  ClientOp.extend({ type: z.literal("op") }),
  z.strictObject({ type: z.literal("presence"), ...PresenceState }), // strict: a client cannot slip in a name or an actor
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  // `you`: this connection's own peerId. `peers`: who was already here. Optional, so that a welcome
  // from a server that predates presence still parses: absent means "nobody else is here".
  // `readOnly`: the room cannot make ops durable right now (E6.1b); absent means it can.
  z.object({ type: z.literal("welcome"), doc: Doc, seq: z.number().int().min(0), you: z.string().optional(), peers: z.array(Presence).optional(), readOnly: z.boolean().optional() }),
  Presence.extend({ type: z.literal("presence") }),
  z.object({ type: z.literal("presence_left"), peerId: z.string() }),
  SequencedOp.extend({ type: z.literal("op") }),
  z.object({ type: z.literal("rejected"), opId: z.uuid(), reason: RejectReason, retryAfterMs: z.number().int().min(0).optional() }),
  // "Received, and it changed nothing" (the value was already that, the node already there). It gets
  // no seq and nobody else hears of it: a no-op must not cost every peer a message and a journal row.
  z.object({ type: z.literal("ack"), opId: z.uuid() }),
  // To EVERY peer when the room's storage fails or comes back (E6.1b, SPEC §4). While read-only the room
  // refuses every op as "unavailable" and acknowledges none: a peer holds its edits and sends them again
  // once it hears `readOnly: false`. An older client skips this type and falls back on the refusals.
  z.object({ type: z.literal("status"), readOnly: z.boolean() }),
  // "Still opening the document": sent every few seconds between the upgrade and the welcome, so that a client's
  // silence watchdog does not give up on a node that is waiting on a slow database (noon-cs6.3.2). It says nothing
  // else. An older client skips the type, but any frame resets its silence clock, so it is helped too.
  z.object({ type: z.literal("loading") }),
  // This session's role changed and the session stays open (noon-frc): an owner demoted to editor may still edit, so
  // nothing else would tell its page to stop showing owner controls. Sent once per change; what the page shows by,
  // never what decides (the room and the api do). An older client skips the type and learns at its next session.
  z.object({ type: z.literal("role"), role: Role }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
