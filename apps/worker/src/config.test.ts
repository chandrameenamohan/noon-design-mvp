import { expect, test } from "vitest";
import { loadConfig } from "./config.ts";

const good = { DATABASE_URL: "postgres://app:pw@db:5432/noon", REDIS_URL: "redis://redis:6379", SESSION_TOKEN_SECRET: "s".repeat(32), SYNC_URL: "ws://sync:3001" };

// unit:worker-refuses-api-key
test("the worker refuses to start when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set, even to nothing", () => {
  // Either one OUTRANKS the OAuth token inside the SDK, even when empty: the runs would be billed to
  // a different account (or fail) and nothing here would say why.
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    for (const value of ["sk-ant-whatever", ""]) {
      expect(() => loadConfig({ ...good, [name]: value }), `${name}=${JSON.stringify(value)}`).toThrow(new RegExp(`${name} must be unset`));
    }
  }
  expect(() => loadConfig({ ...good, ANTHROPIC_API_KEY: "sk-ant-secret-value" })).not.toThrow(/secret-value/); // never echo a value
});

test("the OAuth token is optional at startup (a run without it fails fast, by name), everything else is required", () => {
  expect(loadConfig(good)).toMatchObject({ oauthToken: undefined, model: "claude-opus-5", sessions: { secret: good.SESSION_TOKEN_SECRET, syncUrl: "ws://sync:3001" } });
  expect(loadConfig({ ...good, CLAUDE_CODE_OAUTH_TOKEN: "" }).oauthToken).toBeUndefined(); // an empty line in .env means unset
  expect(loadConfig({ ...good, CLAUDE_CODE_OAUTH_TOKEN: "tok", AI_MODEL: "claude-haiku-4-5" })).toMatchObject({ oauthToken: "tok", model: "claude-haiku-4-5" });
  for (const missing of ["DATABASE_URL", "REDIS_URL", "SESSION_TOKEN_SECRET", "SYNC_URL"]) {
    expect(() => loadConfig({ ...good, [missing]: undefined }), missing).toThrow(new RegExp(missing));
  }
  expect(() => loadConfig({ ...good, SYNC_URL: "http://sync:3001" })).toThrow(/SYNC_URL/);
});

// From the E3.4 review: AI_MODEL is written into every usage row, where the contract caps it at 100
// characters. Looser here meant a run that worked and bookkeeping that vanished, run after run.
test("a model name the usage contract cannot store stops the worker at startup", () => {
  expect(loadConfig({ ...good, AI_MODEL: "x".repeat(100) }).model).toBe("x".repeat(100));
  expect(() => loadConfig({ ...good, AI_MODEL: "x".repeat(101) })).toThrow(/AI_MODEL/);
  expect(() => loadConfig({ ...good, AI_MODEL: "" })).toThrow(/AI_MODEL/);
});

// E4.2b: which queue THIS process drains. ONE: the sandbox holds the Docker daemon, the AI worker runs
// a model's subprocess, and the two never share a process (E4.2a security review).
test("a worker drains the AI queue unless told otherwise, and anything but one known queue stops it", () => {
  expect(loadConfig(good)).toMatchObject({ queue: "ai" });
  expect(loadConfig({ ...good, WORKER_QUEUE: "sandbox" })).toMatchObject({ queue: "sandbox", sandbox: { image: "noon-sandbox:dev", docker: "docker", concurrency: 8 } });
  expect(loadConfig({ ...good, WORKER_QUEUE: "sandbox", SANDBOX_IMAGE: "noon-sandbox:v2", DOCKER: "/usr/local/bin/docker", SANDBOX_CONCURRENCY: "3" })).toMatchObject({ sandbox: { image: "noon-sandbox:v2", docker: "/usr/local/bin/docker", concurrency: 3 } });
  // "ai,sandbox" above all: the AI's subprocess must never share a process with the Docker socket.
  for (const bad of ["", "mail", "ai,sandbox", "AI"]) expect(() => loadConfig({ ...good, WORKER_QUEUE: bad }), bad).toThrow(/WORKER_QUEUE/);
  expect(loadConfig({ ...good, WORKER_QUEUE: "git" })).toMatchObject({ queue: "git", gitDir: "/var/lib/noon-git" });
  expect(loadConfig({ ...good, WORKER_QUEUE: "git", GIT_PEER_DIR: "/data/git" }).gitDir).toBe("/data/git");
  expect(loadConfig({ ...good, WORKER_QUEUE: "ship", GITEA_TOKEN: "t" })).toMatchObject({ queue: "ship", sandbox: { seed: { url: "http://gitea:3000/noon/sample-app.git", auth: { user: "noon", token: "t" } } } });
  expect(() => loadConfig({ ...good, WORKER_QUEUE: "git", GIT_PEER_DIR: "relative/git" })).toThrow(/GIT_PEER_DIR/);
  expect(loadConfig({ ...good, WORKER_QUEUE: "sandbox", SANDBOX_POOL: "noon-clean" }).sandbox.pool).toBe("noon-clean");
  for (const bad of ["", "Has Space", "x=y"]) expect(() => loadConfig({ ...good, SANDBOX_POOL: bad }), bad).toThrow(/SANDBOX_POOL/);
  for (const bad of ["0", "-1", "1.5", "lots"]) expect(() => loadConfig({ ...good, SANDBOX_CONCURRENCY: bad }), bad).toThrow(/SANDBOX_CONCURRENCY/);
});

// noon-9gz: the pool's sandbox proxy, and the key its preview tokens are signed with.
test("the sandbox proxy listens on 20000 unless told otherwise, on a port a non-root process may take", () => {
  expect(loadConfig(good).sandbox.proxyPort).toBe(20000);
  expect(loadConfig({ ...good, SANDBOX_PROXY_PORT: "20100" }).sandbox.proxyPort).toBe(20100);
  for (const bad of ["", "80", "0", "65536", "20000x", "2e4"]) expect(() => loadConfig({ ...good, SANDBOX_PROXY_PORT: bad }), bad).toThrow(/SANDBOX_PROXY_PORT/);
});

test("the preview key is derived from the session secret: stable across restarts, never the secret itself, another secret another key", () => {
  const key = loadConfig(good).sandbox.previewKey;
  expect(key).toMatch(/^[0-9a-f]{64}$/u);
  expect(key).not.toContain(good.SESSION_TOKEN_SECRET);
  expect(loadConfig(good).sandbox.previewKey).toBe(key);
  expect(loadConfig({ ...good, SESSION_TOKEN_SECRET: "t".repeat(32) }).sandbox.previewKey).not.toBe(key);
});

// E5.1: where a sandbox's clone comes from. The WORKER fetches it (a sandbox has no route out, noon-9gz).
test("the seed repo is the compose stack's Gitea unless told otherwise, and its token is optional", () => {
  expect(loadConfig(good).sandbox.seed).toEqual({ url: "http://gitea:3000/noon/sample-app.git" });
  const seed = { url: "http://127.0.0.1:3002/noon/sample-app.git", auth: { user: "noon", token: "t0k" } };
  expect(loadConfig({ ...good, SEED_REPO: seed.url, GITEA_TOKEN: "t0k" }).sandbox.seed).toEqual(seed);
  expect(loadConfig({ ...good, SEED_REPO: seed.url, GITEA_TOKEN: "t0k", GITEA_USER: "someone" }).sandbox.seed.auth).toEqual({ user: "someone", token: "t0k" });
  expect(loadConfig({ ...good, GITEA_TOKEN: "" }).sandbox.seed).toEqual({ url: "http://gitea:3000/noon/sample-app.git" }); // an empty line in .env means unset
  // A credential in the URL would be written into the worker's mirror config and shown in every git error.
  for (const bad of ["", "gitea/noon/sample-app", "http://noon:t0k@gitea:3000/noon/sample-app.git", "-uhttp://x"]) {
    expect(() => loadConfig({ ...good, SEED_REPO: bad }), bad).toThrow(/SEED_REPO/);
  }
  expect(() => loadConfig({ ...good, SEED_REPO: "http://noon:secret-value@gitea:3000/x.git" })).not.toThrow(/secret-value/);
});
