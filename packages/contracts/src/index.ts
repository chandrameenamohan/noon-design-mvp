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

// --- HTTP bodies -------------------------------------------------------------
export const CreateOrgBody = z.strictObject({ name: Name });
export const CreateWorkspaceBody = z.strictObject({ name: Name });
export const CreateDocumentBody = z.strictObject({ title: Name });

/** Every non-2xx response has this shape. `issues` names the failing fields of a rejected body. */
export const ErrorBody = z.object({
  error: z.enum(["invalid_json", "invalid_body", "invalid_query", "unsupported_media_type", "payload_too_large", "unauthenticated", "not_found", "not_ready", "internal"]),
  issues: z.array(z.object({ field: z.string().min(1), message: z.string() })).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// --- Live editing session (F3) ---------------------------------------------------
/** Where to open the WebSocket for a document, and the short-lived token that lets you in. */
export const SessionResponse = z.object({ wsUrl: z.url(), token: z.string().min(1), expiresAt: Timestamp });
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

// --- WebSocket messages (presence messages join in E2.6) -------------------------------------
export const ClientMessage = z.discriminatedUnion("type", [ClientOp.extend({ type: z.literal("op") })]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), doc: Doc, seq: z.number().int().min(0) }),
  SequencedOp.extend({ type: z.literal("op") }),
  z.object({ type: z.literal("rejected"), opId: z.uuid(), reason: RejectReason }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
