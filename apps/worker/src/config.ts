import { z } from "zod";
import { DatabaseUrl, parseEnv } from "@noon/process/env";
import { RedisUrl } from "@noon/queue";

const Env = z.object({ DATABASE_URL: DatabaseUrl, REDIS_URL: RedisUrl });

export function loadConfig(env: Record<string, string | undefined>): { databaseUrl: string; redisUrl: string } {
  const parsed = parseEnv(Env, env);
  return { databaseUrl: parsed.DATABASE_URL, redisUrl: parsed.REDIS_URL };
}
