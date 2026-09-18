import { z } from "zod";

/** Body of GET /health. The first contract: one schema, one inferred type. */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
