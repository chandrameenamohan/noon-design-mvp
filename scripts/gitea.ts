import { execFile } from "node:child_process";
import { promisify } from "node:util";

// E5.1: what init.sh does to Gitea once the noon user and its token exist: the repo, the seed in it, the
// webhook. Safe to run again. The integration test (apps/worker/src/gitea.int.test.ts) runs it too.

const exec = promisify(execFile);
const REPO_ROOT = new URL("../", import.meta.url).pathname;

export type GiteaSetup = {
  /** Where THIS process reaches Gitea (the host: 127.0.0.1 and GITEA_PORT). */
  url: string;
  user: string;
  token: string;
  repo: string;
  /** Where Gitea delivers pushes (inside the compose network), and the HMAC secret it signs them with. */
  webhook: { url: string; secret: string };
};

/**
 * The seed as ONE commit whose tree is seed/sample-app at HEAD, made from this repository's own objects:
 * no temp directory, nothing uncommitted. A fixed author and date, so the same tree gives the same commit
 * id on every machine and every run.
 */
export async function seedCommit(): Promise<string> {
  const who = { GIT_AUTHOR_NAME: "noon", GIT_AUTHOR_EMAIL: "noon@localhost", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" };
  const env = { ...process.env, ...who, GIT_COMMITTER_NAME: who.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: who.GIT_AUTHOR_EMAIL, GIT_COMMITTER_DATE: who.GIT_AUTHOR_DATE };
  return (await exec("git", ["-C", REPO_ROOT, "commit-tree", "-m", "seed: the sample app", "HEAD:seed/sample-app"], { env })).stdout.trim();
}

/** Pushes the seed commit as `main` of `remote` (a URL or a local path). The token goes as a header, never into the URL. */
export async function pushSeed(remote: string, auth?: { user: string; token: string }): Promise<string> {
  const commit = await seedCommit();
  const header = auth ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${auth.user}:${auth.token}`).toString("base64")}` } : {};
  await exec("git", ["-C", REPO_ROOT, "push", "--quiet", "--", remote, `${commit}:refs/heads/main`], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...header } });
  return commit;
}

type Hook = { id: number; config: { url?: string } };

export async function bootstrapGitea(setup: GiteaSetup): Promise<void> {
  const api = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${setup.url}/api/v1${path}`, {
      method,
      headers: { authorization: `token ${setup.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // 409 on create is "it exists already", which a second run expects.
    if (!res.ok && !(method === "POST" && path === "/user/repos" && res.status === 409)) throw new Error(`Gitea ${method} ${path} -> ${String(res.status)}: ${await res.text()}`);
    return res;
  };
  const repo = `/repos/${setup.user}/${setup.repo}`;
  // Private: the worker reads it with the token, and nobody else on this machine reads it at all.
  await api("POST", "/user/repos", { name: setup.repo, private: true, default_branch: "main" });
  // Only an EMPTY repo gets the seed: after the first run it holds the owner's commits, never overwritten.
  const { empty } = (await (await api("GET", repo)).json()) as { empty?: unknown };
  if (empty === true) await pushSeed(`${setup.url}/${setup.user}/${setup.repo}.git`, { user: setup.user, token: setup.token });
  // One hook per URL, its secret kept in step with .env: updated when it exists, made when it does not.
  const hook = { active: true, events: ["push"], config: { url: setup.webhook.url, content_type: "json", secret: setup.webhook.secret } };
  const hooks = (await (await api("GET", `${repo}/hooks`)).json()) as Hook[];
  const ours = hooks.find((each) => each.config.url === setup.webhook.url);
  if (ours) await api("PATCH", `${repo}/hooks/${String(ours.id)}`, hook);
  else await api("POST", `${repo}/hooks`, { type: "gitea", ...hook });
}
