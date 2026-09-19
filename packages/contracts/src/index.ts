import { z } from "zod";

/** Body of GET /health. The first contract: one schema, one inferred type. */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponse>;

const Id = z.uuid();
const Name = z.string().trim().min(1).max(200);
const Timestamp = z.iso.datetime();

export const Org = z.object({ id: Id, name: Name, createdAt: Timestamp });
export type Org = z.infer<typeof Org>;

export const Workspace = z.object({ id: Id, orgId: Id, name: Name, createdAt: Timestamp });
export type Workspace = z.infer<typeof Workspace>;

export const Document = z.object({ id: Id, orgId: Id, workspaceId: Id, title: Name, createdAt: Timestamp });
export type Document = z.infer<typeof Document>;
