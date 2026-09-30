import { createHmac } from "node:crypto";
import { z } from "zod";
import { DatabaseUrl, parseEnv } from "@noon/process/env";
import { RedisUrl } from "@noon/queue";

// Either of these OUTRANKS the OAuth token inside the SDK, even when set to nothing (SPEC §2.13):
// runs would go to another account, or fail, with nothing here to say why. So: refuse to start.
const mustBeUnset = (name: string) => z.undefined({ error: `${name} must be unset in the worker: it outranks CLAUDE_CODE_OAUTH_TOKEN` }).optional();

const Env = z.object({
  DATABASE_URL: DatabaseUrl,
  REDIS_URL: RedisUrl,
  // The worker signs its own session tokens (actor = agent) with the secret the sync server verifies.
  SESSION_TOKEN_SECRET: z.string({ error: "SESSION_TOKEN_SECRET is required" }).min(32, "SESSION_TOKEN_SECRET must be at least 32 characters"),
  // How THIS process reaches the sync server. Not SYNC_PUBLIC_URL: that one is for browsers.
  SYNC_URL: z.string({ error: "SYNC_URL is required" }).refine((value) => URL.canParse(value) && ["ws:", "wss:"].includes(new URL(value).protocol), "SYNC_URL must be a ws:// or wss:// URL").transform((value) => value.replace(/\/+$/, "")),
  // Optional at startup: without it every run fails at once as `token_missing`, which the user can read.
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional().transform((value) => (value === "" ? undefined : value)),
  // Written into every usage row, where the contract caps it at 100 characters (a gateway alias or an
  // inference-profile ARN is longer than that): refuse it here, at startup, not once per finished run.
  AI_MODEL: z.string().min(1, "AI_MODEL must not be empty").max(100, "AI_MODEL must be at most 100 characters").default("claude-opus-5"),
  ANTHROPIC_API_KEY: mustBeUnset("ANTHROPIC_API_KEY"),
  ANTHROPIC_AUTH_TOKEN: mustBeUnset("ANTHROPIC_AUTH_TOKEN"),
  // ONE queue per process. The sandbox queue needs the Docker daemon, which is root on the host; the
  // AI queue runs a model's subprocess. They never share a process (E4.2a security review).
  WORKER_QUEUE: z.enum(["ai", "sandbox"], { error: "WORKER_QUEUE must be ai or sandbox" }).default("ai"),
  SANDBOX_IMAGE: z.string().min(1).default("noon-sandbox:dev"),
  DOCKER: z.string().min(1).default("docker"),
  // This stack's sandboxes: the only ones its reaper may remove (the daemon is shared with tests).
  SANDBOX_POOL: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, "SANDBOX_POOL must be lowercase letters, digits and hyphens").default("default"),
  // Each running sandbox job holds a container (1 CPU, 1 GiB) while its document is open: this is the cap.
  SANDBOX_CONCURRENCY: z.string().regex(/^[1-9]\d{0,3}$/u, "SANDBOX_CONCURRENCY must be a whole number from 1").transform(Number).default(8),
  // The pool's sandbox proxy, on 127.0.0.1: every preview of this stack answers here (noon-9gz). The
  // canvas's dev server forwards /preview/ to it (apps/web: SANDBOX_PROXY_URL).
  SANDBOX_PROXY_PORT: z.string().regex(/^\d{4,5}$/u, "SANDBOX_PROXY_PORT must be a port number").transform(Number).refine((port) => port >= 1024 && port <= 65535, "SANDBOX_PROXY_PORT must be from 1024 to 65535").default(20000),
});

export function loadConfig(env: Record<string, string | undefined>): {
  databaseUrl: string; redisUrl: string; sessions: { secret: string; syncUrl: string }; oauthToken: string | undefined; model: string;
  queue: "ai" | "sandbox"; sandbox: { image: string; docker: string; pool: string; concurrency: number; proxyPort: number; previewKey: string };
} {
  const parsed = parseEnv(Env, env);
  // The preview tokens' key, derived and not a new secret in .env: the sync server's secret never leaves
  // this process (the proxy gets only the derived key), and a stack whose .env predates noon-9gz starts.
  const previewKey = createHmac("sha256", parsed.SESSION_TOKEN_SECRET).update("noon-sandbox-preview-key").digest("hex");
  return {
    databaseUrl: parsed.DATABASE_URL, redisUrl: parsed.REDIS_URL, sessions: { secret: parsed.SESSION_TOKEN_SECRET, syncUrl: parsed.SYNC_URL }, oauthToken: parsed.CLAUDE_CODE_OAUTH_TOKEN, model: parsed.AI_MODEL,
    queue: parsed.WORKER_QUEUE, sandbox: { image: parsed.SANDBOX_IMAGE, docker: parsed.DOCKER, pool: parsed.SANDBOX_POOL, concurrency: parsed.SANDBOX_CONCURRENCY, proxyPort: parsed.SANDBOX_PROXY_PORT, previewKey },
  };
}
