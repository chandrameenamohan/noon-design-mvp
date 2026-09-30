import { z } from "zod";
import { NodeId } from "@noon/lease";
import { DatabaseUrl, parseEnv, port } from "@noon/process/env";
import { RedisUrl } from "@noon/queue";

const positive = (name: string, fallback: number) =>
  z.string().optional().transform((value) => (value === undefined || value === "" ? String(fallback) : value)).pipe(z.string().regex(/^[1-9]\d{0,8}$/, `${name} must be a positive whole number`).transform(Number));

const Env = z.object({
  // Where documents are loaded from and saved to: the same limited role the api uses.
  DATABASE_URL: DatabaseUrl,
  // The api signs session tokens with this; the sync server verifies them. A comma-separated list
  // allows rotation without an outage: verifiers get "new,old", the signer switches, then "new".
  SESSION_TOKEN_SECRET: z
    .string({ error: "SESSION_TOKEN_SECRET is required" })
    .transform((value) => value.split(",").map((s) => s.trim()).filter(Boolean))
    .refine((secrets) => secrets.length > 0 && secrets.every((s) => s.length >= 32), "SESSION_TOKEN_SECRET: every secret must be at least 32 characters"),
  PORT: port(3001),
  // E6.2: where rooms write their snapshots. No defaults: an address or a password is never guessed.
  MINIO_URL: z.string({ error: "MINIO_URL is required" }).refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), "MINIO_URL must be an http(s):// URL"),
  MINIO_USER: z.string({ error: "MINIO_USER is required" }).min(1, "MINIO_USER is required"),
  MINIO_PASSWORD: z.string({ error: "MINIO_PASSWORD is required" }).min(8, "MINIO_PASSWORD must be at least 8 characters"),
  SNAPSHOT_BUCKET: z.string().optional().transform((value) => value || "snapshots"),
  // Tunable (SPEC §2.9): every N ops, every T seconds while peers are connected, and always on last leave.
  SNAPSHOT_EVERY_OPS: positive("SNAPSHOT_EVERY_OPS", 500),
  SNAPSHOT_EVERY_SECONDS: positive("SNAPSHOT_EVERY_SECONDS", 30),
  // E7.1: room leases (F20). The node id is how the api's and worker's routing tables name this process.
  REDIS_URL: RedisUrl,
  SYNC_NODE_ID: z.string({ error: "SYNC_NODE_ID is required" }).pipe(NodeId),
  // How long a room survives its owner going silent (E7.2's failover time). Renewed every third of it.
  LEASE_TTL_MS: positive("LEASE_TTL_MS", 10_000),
});

export function loadConfig(env: Record<string, string | undefined>) {
  const parsed = parseEnv(Env, env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    secrets: parsed.SESSION_TOKEN_SECRET,
    port: parsed.PORT,
    minio: { endpoint: parsed.MINIO_URL, accessKeyId: parsed.MINIO_USER, secretAccessKey: parsed.MINIO_PASSWORD, bucket: parsed.SNAPSHOT_BUCKET },
    cadence: { everyOps: parsed.SNAPSHOT_EVERY_OPS, everyMs: parsed.SNAPSHOT_EVERY_SECONDS * 1000 },
    lease: { redisUrl: parsed.REDIS_URL, nodeId: parsed.SYNC_NODE_ID, ttlMs: parsed.LEASE_TTL_MS },
  };
}
