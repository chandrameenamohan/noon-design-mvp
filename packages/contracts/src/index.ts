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
