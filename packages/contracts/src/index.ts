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
  error: z.enum(["invalid_json", "invalid_body", "invalid_query", "unsupported_media_type", "payload_too_large", "not_found", "not_ready", "internal"]),
  issues: z.array(z.object({ field: z.string().min(1), message: z.string() })).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// --- Paging --------------------------------------------------------------------
// Every list is paged from the first version: adding it later would break every client.
export const PageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** `nextCursor` is opaque to clients: pass it back unchanged, or stop when it is null. */
export type Page<T> = { items: T[]; nextCursor: string | null };
