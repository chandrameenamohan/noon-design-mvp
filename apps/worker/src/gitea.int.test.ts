import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bootstrapGitea, seedCommit } from "../../../scripts/gitea.ts";
import { sandboxName, startSandbox, type SandboxOptions } from "./sandbox.ts";
import { buildImage, DOCKER, docker, dockerEnv, IMAGE, removePool, TEST_PREVIEW_KEY, testPool } from "./sandbox-testing.ts";

// E5.1, integration:gitea-bootstrap. The dev stack's REAL Gitea (./init.sh made its user, token, repo and
// webhook), real git, real Docker. Each test repo is this file's own and is deleted after.
const GITEA = `http://127.0.0.1:${process.env["GITEA_PORT"] ?? "3002"}`;
const TOKEN = process.env["GITEA_TOKEN"] ?? "";
const WEBHOOK = "http://api:3000/webhooks/gitea";
const auth = { authorization: `token ${TOKEN}`, "content-type": "application/json" };
const gitea = async (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${GITEA}/api/v1${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T>(res: Promise<Response>): Promise<T> => {
  const answer = await res;
  if (!answer.ok) throw new Error(`Gitea -> ${String(answer.status)}: ${await answer.text()}`);
  return answer.json() as Promise<T>;
};
const mainOf = async (repo: string): Promise<string> => (await json<{ commit: { id: string } }>(gitea("GET", `/repos/noon/${repo}/branches/main`))).commit.id;
type Hook = { id: number; active: boolean; events: string[]; config: { url: string; content_type: string } };

const repos: string[] = [];
const newRepo = (): string => {
  repos.push(`test-${randomUUID().slice(0, 8)}`);
  return repos.at(-1) ?? "";
};
const setup = (repo: string, secret = "a-webhook-secret") => ({ url: GITEA, user: "noon", token: TOKEN, repo, webhook: { url: WEBHOOK, secret } });
const pool = testPool();
// 25000: never the compose stack's proxy (20000), e2e's (20100), or another suite's (21000, 24000).
const options = (repo: string): SandboxOptions => ({ image: IMAGE, docker: DOCKER, pool, previewKey: TEST_PREVIEW_KEY, proxyPort: 25000, seed: { url: `${GITEA}/noon/${repo}.git`, auth: { user: "noon", token: TOKEN } } });
const made: string[] = [];
const newDocument = (): string => {
  made.push(randomUUID());
  return made.at(-1) ?? "";
};
const inSandbox = async (id: string, ...command: string[]): Promise<string> => (await promisify(execFile)(DOCKER, ["exec", sandboxName(id), ...command], { timeout: 30_000, env: dockerEnv })).stdout.trim();

beforeAll(async () => {
  if (!TOKEN) throw new Error("GITEA_TOKEN is not in .env: run ./init.sh");
  await buildImage();
}, 900_000);
afterAll(async () => {
  if (made.length > 0) await docker("rm", "--force", ...made.map(sandboxName)).catch(() => undefined);
  await removePool(pool);
  for (const repo of repos) await gitea("DELETE", `/repos/noon/${repo}`);
});

test("Gitea listens on the host's loopback only, and serves the seed repo to its token and to nobody else", async () => {
  const published = await promisify(execFile)(DOCKER, ["compose", "port", "gitea", "3000"], { env: dockerEnv });
  expect(published.stdout.trim()).toMatch(/^127\.0\.0\.1:\d+$/u);
  // What init.sh left: the private repo with the seed as main, and the push hook to the api.
  expect(await json<{ private: boolean }>(gitea("GET", "/repos/noon/sample-app"))).toMatchObject({ private: true });
  expect((await fetch(`${GITEA}/api/v1/repos/noon/sample-app`)).status).not.toBe(200); // no token, no repo
  expect((await fetch(`${GITEA}/noon/sample-app.git/info/refs?service=git-upload-pack`)).status).not.toBe(200); // nor a clone
  const seeded = await fetch(`${GITEA}/api/v1/repos/noon/sample-app/raw/package.json?ref=main`, { headers: auth });
  expect(seeded.status).toBe(200);
  const hooks = await json<Hook[]>(gitea("GET", "/repos/noon/sample-app/hooks"));
  expect(hooks.filter((hook) => hook.config.url === WEBHOOK)).toEqual([expect.objectContaining({ active: true, events: ["push"], config: expect.objectContaining({ content_type: "json" }) as unknown })]);
});

test("the bootstrap makes a private repo, pushes the seed, registers one hook, and a second run changes nothing", async () => {
  const repo = newRepo();
  await bootstrapGitea(setup(repo));
  expect(await json<{ private: boolean; default_branch: string }>(gitea("GET", `/repos/noon/${repo}`))).toMatchObject({ private: true, default_branch: "main" });
  expect(await mainOf(repo)).toBe(await seedCommit()); // the sample app's tree at HEAD, nothing else
  const once = await json<Hook[]>(gitea("GET", `/repos/noon/${repo}/hooks`));
  expect(once).toHaveLength(1);
  await bootstrapGitea(setup(repo, "a-rotated-secret"));
  const twice = await json<Hook[]>(gitea("GET", `/repos/noon/${repo}/hooks`));
  expect(twice.map((hook) => hook.id)).toEqual(once.map((hook) => hook.id)); // updated in place, not a second hook
});

test("the bootstrap never overwrites a repo that has moved on: the owner's commits stay", async () => {
  const repo = newRepo();
  await bootstrapGitea(setup(repo));
  const theirs = await json<{ commit: { sha: string } }>(gitea("POST", `/repos/noon/${repo}/contents/OWNER.md`, { content: Buffer.from("mine\n").toString("base64"), message: "the owner's commit", branch: "main" }));
  await bootstrapGitea(setup(repo));
  expect(await mainOf(repo)).toBe(theirs.commit.sha);
});

test("a sandbox clones from Gitea through the worker: Gitea's main, no credential inside, no route to Gitea", async () => {
  const repo = newRepo();
  await bootstrapGitea(setup(repo));
  const id = newDocument();
  await startSandbox(id, options(repo));
  expect(await inSandbox(id, "git", "rev-parse", "origin/main")).toBe(await mainOf(repo));
  expect(await inSandbox(id, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(`noon/${id}`);
  // Customer code reads .git/config and its environment: the token is in neither, and origin is a file.
  expect(await inSandbox(id, "git", "remote", "get-url", "origin")).toBe("/tmp/seed.bundle");
  expect(await inSandbox(id, "cat", ".git/config")).not.toContain(TOKEN);
  expect(await docker("container", "inspect", "--format", "{{json .Config.Env}}", sandboxName(id))).not.toContain(TOKEN);
  // And it cannot fetch for itself: neither Gitea by its compose name nor the host's published port.
  for (const url of ["http://gitea:3000/", `http://host.docker.internal:${new URL(GITEA).port}/`]) {
    const probe = `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0), () => process.exit(7))`;
    await expect(inSandbox(id, "node", "-e", probe), url).rejects.toMatchObject({ code: 7 });
  }
}, 90_000);

test("a push to Gitea reaches the next sandbox that starts: the worker fetches on every start", async () => {
  const repo = newRepo();
  await bootstrapGitea(setup(repo));
  await startSandbox(newDocument(), options(repo)); // the worker's mirror now exists
  const pushed = await json<{ commit: { sha: string } }>(gitea("POST", `/repos/noon/${repo}/contents/LATER.md`, { content: Buffer.from("later\n").toString("base64"), message: "a later push", branch: "main" }));
  const id = newDocument();
  await startSandbox(id, options(repo));
  expect(await inSandbox(id, "git", "rev-parse", "origin/main")).toBe(pushed.commit.sha);
  expect(await inSandbox(id, "cat", "LATER.md")).toBe("later");
}, 90_000);

test("a seed the worker cannot read fails the start, by git's own words, and never hangs the sandbox", async () => {
  const id = newDocument();
  const nobody = { ...options(newRepo()), seed: { url: `${GITEA}/noon/sample-app.git`, auth: { user: "noon", token: "not-a-token" } } };
  await expect(startSandbox(id, nobody)).rejects.toThrow(/git clone/u);
  expect(String(await docker("container", "inspect", "--format", "{{json .Config.Env}}", sandboxName(id)).catch((err: unknown) => err))).not.toContain("not-a-token");
}, 60_000);
