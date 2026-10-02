import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { previewToken } from "./sandbox-proxy.ts";

/**
 * The sandbox: one container per document working branch, running the sample app's own dev server
 * (apps/worker/sandbox/Dockerfile). This file STARTS one and says where it answers. Pushing the
 * generated file into it and reaping idle ones is E4.2b.
 *
 * Docker is the registry: the container's NAME is the document's, and there is no table to fall out
 * of step with what is actually running. Who may START one is a separate question, answered twice:
 * inside this process, concurrent starts of one document share a single attempt (below); across
 * processes, only the one holding the document's unfinished `sandbox` job starts it (E4.2b's unique
 * index, the same rule as one AI run per document). Name uniqueness alone was NOT enough: ten
 * racing callers removed each other's containers (the E4.2a verifier's trace, and a test now).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CONTAINER_PORT = 5173;
const LABEL = "noon.sandbox";
/** Goes into a `key=value` label and a `--filter`: nothing that could end the value early. */
const POOL = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const checkPool = (pool: string): void => {
  if (!POOL.test(pool)) throw new Error(`not a sandbox pool name: ${JSON.stringify(pool)}`);
};
/**
 * The pool's proxy (sandbox-proxy.ts): the only published port, and the only other member of every
 * sandbox's network. Its program is that file, handed to `node -e` in the sandbox image (which has
 * Node and nothing of ours), so no second image to build or keep in step.
 */
const proxyName = (pool: string): string => `noon-sandbox-proxy-${pool}`;
const PROXY_PORT = 8080;
const PROXY_PROGRAM = `${readFileSync(new URL("sandbox-proxy.ts", import.meta.url), "utf8")}\nservePreviews({ key: process.env.PREVIEW_KEY ?? "", port: ${String(PROXY_PORT)} });\n`;
/** Names what a key signs without naming the key: a label anyone with `docker inspect` can read. */
export const fingerprint = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);

/**
 * Where every sandbox's clone comes from (E5.1: the org's repo in Gitea). The WORKER fetches it: a
 * sandbox's network has no route out (noon-9gz). `auth` goes to git as a header in the environment,
 * never into a URL, an argument or any repository's config.
 */
export type SeedRepo = { url: string; auth?: { user: string; token: string } };
/** Where start.sh waits for the seed, and clones from: a file in the sandbox's own /tmp. */
const SEED_BUNDLE = "/tmp/seed.bundle";
/** The sandbox's /tmp is a 64m tmpfs: a bigger bundle could never land there, so never hold one either. */
const MAX_BUNDLE = 64 * 1024 * 1024;

/** `url` is where the dev server answers, through the pool's proxy, its base included: http://127.0.0.1:<proxy port>/preview/<document>/<token>/. */
export type Sandbox = { container: string; url: string };
export type SandboxOptions = {
  image: string;
  /**
   * Whose sandboxes these are: the label every container carries, and the only ones a reaper with
   * the same pool may remove. The compose stack, `make clean-clone` and each test file share one
   * Docker daemon; without this, one stack's reaper removed another's sandboxes (it happened).
   */
  pool: string;
  /**
   * Signs every preview token (sandbox-proxy.ts). Only this process and the pool's proxy hold it; a
   * sandbox never does. At least 32 characters.
   */
  previewKey: string;
  seed: SeedRepo;
  /** The docker CLI. Docker Desktop does not always put it on PATH. */
  docker?: string;
  /** Where the pool's proxy listens, on 127.0.0.1: the one address every preview of the pool shares. */
  proxyPort?: number;
  /** The whole start, first docker call to first HTTP 200. */
  readyTimeoutMs?: number;
  /** Aborted = give up now (the job was cancelled, or the worker is stopping). */
  signal?: AbortSignal;
};
type Run = (...args: string[]) => Promise<string>;

export const sandboxName = (documentId: string): string => `noon-sandbox-${documentId}`;
/** Where the generated page lives in the document's clone: the one file the document owns (keystone 8). */
export const pagePath = (documentId: string): string => `src/pages/noon-${documentId}.tsx`;
/** The sandbox's own entry that renders that page, relative to the sandbox's URL (the Dockerfile writes it). */
export const PREVIEW_PATH = "noon-preview/";
/**
 * The address the canvas frames. It NAMES the document, and the sandbox's entry renders nothing for
 * another one: a second lock behind the base, which already names the document and its container.
 */
export const previewUrl = (sandboxUrl: string, documentId: string): string => new URL(`${PREVIEW_PATH}?doc=${documentId}`, sandboxUrl).href;
/**
 * The path the sandbox's dev server serves under (Vite's `base`), and refuses everything outside of
 * (the Dockerfile's config): /preview/<document>/<token>/, the token minted for THIS container (a fresh
 * nonce each time one is created). The pool's proxy checks the token's signature; the sandbox checks it
 * is its own. The canvas's dev server carries the same path on its own origin behind one public URL
 * (noon-l96), so the document id alone opens nothing, there or here (noon-9gz).
 */
const previewBase = (documentId: string, key: string): string => `/preview/${documentId}/${previewToken(key, documentId, randomBytes(8).toString("hex"))}/`;

const starting = new Map<string, Promise<Sandbox>>();
/** Per pool: the proxy this process last made sure of, by its label. */
const proxies = new Map<string, { want: string; made: Promise<void> }>();
/** Per mirror: the last fetch-and-bundle, so two starts never run git in one mirror at once (ref locks). */
const mirrors = new Map<string, Promise<Buffer>>();

/**
 * Starts the document's sandbox, or finds the one already running, and resolves once its dev
 * server answers. Safe to call again at any time: a running sandbox is returned as it is, a stopped
 * one is started again on its old URL but with a FRESH CLONE (the working tree is a sized tmpfs, the
 * disk quota: it does not outlive the container's run; the preview job pushes the page again).
 *
 * The origin never changes: every preview answers on the pool proxy's one port (SPEC §2a's self-heal
 * wants the same origin). A container made anew (reaped, a new image, a new key) gets a new token, so
 * callers must read the URL from the result every time, never keep the first one.
 */
export function startSandbox(documentId: string, options: SandboxOptions): Promise<Sandbox> {
  // The id becomes a container name, a label and a git branch. execFile has no shell, but a
  // branch called `--upload-pack=...` is still an argument. Only a plain uuid gets past here.
  if (!UUID.test(documentId)) return Promise.reject(new Error(`not a document id: ${JSON.stringify(documentId)}`));
  if (!POOL.test(options.pool)) return Promise.reject(new Error(`not a sandbox pool name: ${JSON.stringify(options.pool)}`));
  if (options.previewKey.length < 32) return Promise.reject(new Error("the preview key must be at least 32 characters"));
  // ponytail: a caller that joins an attempt in flight gets THAT attempt's deadline and signal. Fine
  // while the only caller per document is its one sandbox job (E4.2b).
  let attempt = starting.get(documentId);
  if (!attempt) {
    attempt = start(documentId, options).finally(() => starting.delete(documentId));
    starting.set(documentId, attempt);
  }
  return attempt;
}

async function start(documentId: string, options: SandboxOptions): Promise<Sandbox> {
  const { docker = "docker", proxyPort = 20000, readyTimeoutMs = 60_000 } = options;
  const deadline = AbortSignal.any([AbortSignal.timeout(readyTimeoutMs), ...(options.signal ? [options.signal] : [])]);
  const run: Run = (...args) => dockerCli(docker, args, deadline);
  const name = sandboxName(documentId);
  try {
    await ensureProxy(run, options.pool, options.image, options.previewKey, proxyPort);
    await ensureNetwork(run, name, documentId, options.pool);
    // A container that was already running has its clone; one that was just (re)started waits for the seed.
    if (await create(run, name, documentId, options)) await deliverSeed(docker, name, options.seed, deadline);
    // Every start, not only the first: a proxy made anew since (a new key, a new program) is on no
    // sandbox's network until it is joined again.
    await join(run, name, proxyName(options.pool)).catch(async (err: unknown) => {
      // The proxy this process made sure of is gone (docker rm, a prune) while it lived: forget it, make it again, once (noon-9gz.1).
      if (!String(err).includes("No such container")) throw err;
      proxies.delete(options.pool);
      await ensureProxy(run, options.pool, options.image, options.previewKey, proxyPort);
      await join(run, name, proxyName(options.pool));
    });
    await ready(run, name, deadline);
    // The base is read AFTER the dev server answered, from the container that answered: never one
    // remembered from before a restart that somebody else may have finished differently.
    return { container: name, url: `http://127.0.0.1:${String(proxyPort)}${await baseOf(run, name)}` };
  } catch (err) {
    // A deadline or a cancel ends every docker call with the same anonymous AbortError; say which.
    if (options.signal?.aborted) throw new Error(`${name}: start cancelled`, { cause: err });
    if (deadline.aborted) throw new Error(`${name}: not ready within ${String(readyTimeoutMs)} ms`, { cause: err });
    throw err;
  }
}

/**
 * Makes sure the container exists, is running, and is of the current image and key: started again if
 * stopped, made anew otherwise. True when it was started here (its empty tmpfs needs the seed).
 */
async function create(run: Run, name: string, documentId: string, options: SandboxOptions): Promise<boolean> {
  // Asked once per start: `make sandbox-image` retags the image, and a container of the old one must
  // not be started again as if nothing had changed (E4.2a spec note 3).
  const image = (await run("image", "inspect", "--format", "{{.Id}}", options.image)).trim();
  const key = fingerprint(options.previewKey);
  const found = await restarted(run, name, image, key);
  if (found) return found === "started";
  try {
    await run("run", "--detach", "--name", name,
      "--label", `${LABEL}=${options.pool}`, "--label", `noon.document=${documentId}`, "--label", `noon.key=${key}`,
      "--env", `BRANCH=noon/${documentId}`, "--env", `PAGE=${pagePath(documentId)}`,
      // Fixed for the container's life: a restarted container keeps it, a recreated one gets a new token.
      "--env", `PREVIEW_BASE=${previewBase(documentId, options.previewKey)}`,
      // Its own --internal network (ensureNetwork): no egress, no host, no other sandbox, no published port.
      "--network", name,
      // It runs code nobody here wrote (the customer's repo) and code generated from user input.
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
      "--memory", "1g", "--memory-swap", "1g", "--cpus", "1",
      // The disk quota: nothing on the image's filesystem is writable. The working tree is a sized tmpfs
      // (node_modules is a link into the image, read-only), and so is /tmp. Both count against --memory,
      // so filling them costs this sandbox its own memory, never the host's disk.
      "--read-only", "--tmpfs", "/app:size=256m,uid=1000,gid=1000,mode=0755", "--tmpfs", "/tmp:size=64m",
      options.image);
    return true;
  } catch (err) {
    // A name conflict means another process created it: find that one.
    const found = String(err).includes("is already in use by container") && await restarted(run, name, image, key);
    if (!found) throw err;
    return found === "started";
  }
}

/**
 * "running" or "started" (it was stopped) when the container exists and is now running; false when there
 * is none. One of another image, or with a token signed by another key (the proxy would refuse every
 * request), is removed: false.
 */
async function restarted(run: Run, name: string, image: string, key: string): Promise<"running" | "started" | false> {
  let state: string;
  try {
    state = (await run("container", "inspect", "--format", `{{.State.Running}} {{.Image}} {{index .Config.Labels "noon.key"}}`, name)).trim();
  } catch (err) {
    if (String(err).includes("No such container")) return false;
    throw err;
  }
  const [running, was, signed] = state.split(" ");
  if (was !== image || signed !== key) {
    await run("rm", "--force", name);
    return false;
  }
  if (running === "true") return "running";
  await run("start", name);
  return "started";
}

/**
 * Hands the seed to a container that just started: `main` as a git bundle, written into its /tmp, where
 * start.sh waits for it and clones from it. The sandbox has no route to Gitea (its network is --internal,
 * noon-9gz), so the worker, which has one, fetches and hands the history over by `docker exec`, the way it
 * already hands over the page. The clone's `origin` is that file: no host, no credential for customer code
 * to read in .git/config (noon-9gz note e). Written under another name and renamed: start.sh never reads half.
 * Rejected: a route from the proxy to Gitea (customer code would reach every repo the token reads).
 */
async function deliverSeed(docker: string, name: string, seed: SeedRepo, deadline: AbortSignal): Promise<void> {
  const bundle = await bundleOf(seed, deadline);
  await dockerCli(docker, ["exec", "--interactive", name, "sh", "-c", `cat > ${SEED_BUNDLE}.part && mv ${SEED_BUNDLE}.part ${SEED_BUNDLE}`], deadline, bundle);
}

/**
 * `main` of the seed repo as a bundle, from this process's bare mirror of it, fetched first: every start
 * gets what Gitea has now. One git at a time per mirror. The pid is in the path: test files share a /tmp.
 * ponytail: the mirror lives in /tmp (a restarted worker clones it again) and the bundle is held whole in
 * memory, up to the sandbox's 64m /tmp. Ceiling: repos of that size; upgrade: the git peer's mirror volume
 * (SPEC §2.15) and a bundle piped straight into `docker exec`.
 */
function bundleOf(seed: SeedRepo, deadline: AbortSignal): Promise<Buffer> {
  const mirror = joinPath(tmpdir(), `noon-seed-${String(process.pid)}-${fingerprint(seed.url)}.git`);
  const git = async (...args: string[]): Promise<Buffer> => (await cli("git", args, deadline, { env: gitEnv(seed), name: `git ${args.join(" ")}` })).stdout;
  const next = (mirrors.get(mirror) ?? Promise.resolve(Buffer.alloc(0))).catch(() => undefined).then(async () => {
    // "--" : a URL is never an option. A clone killed halfway is finished by the next fetch.
    if (existsSync(joinPath(mirror, "HEAD"))) await git("-C", mirror, "fetch", "--quiet", "--prune", "origin");
    else await git("clone", "--quiet", "--mirror", "--", seed.url, mirror);
    return git("-C", mirror, "bundle", "create", "--quiet", "-", "main");
  });
  mirrors.set(mirror, next);
  return next;
}

/** git's environment: the token as an HTTP header (GIT_CONFIG_*, git >= 2.31), and never a prompt. */
export function gitEnv(seed: SeedRepo): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!seed.auth) return env;
  const basic = Buffer.from(`${seed.auth.user}:${seed.auth.token}`).toString("base64");
  return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

/**
 * Puts the generated file into the running sandbox: `docker exec`, measured the fastest and the most
 * reliable way (learning-tests/sandbox FINDINGS 2: `cat >` itself, zero missed updates once pushes
 * are paced; no bind mount). The target is the container's own PAGE, set when it was created, so
 * nothing from the caller reaches the shell.
 */
export async function pushPage(documentId: string, tsx: string, options: SandboxOptions): Promise<void> {
  if (!UUID.test(documentId)) throw new Error(`not a document id: ${JSON.stringify(documentId)}`);
  const deadline = AbortSignal.any([AbortSignal.timeout(options.readyTimeoutMs ?? 10_000), ...(options.signal ? [options.signal] : [])]);
  await dockerCli(options.docker ?? "docker", ["exec", "--interactive", sandboxName(documentId), "sh", "-c", `cat > "$PAGE"`], deadline, tsx);
}

/** Is the document's container running? False when it exited, was stopped, or does not exist. */
export async function isRunning(documentId: string, options: SandboxOptions): Promise<boolean> {
  if (!UUID.test(documentId)) throw new Error(`not a document id: ${JSON.stringify(documentId)}`);
  const deadline = AbortSignal.any([AbortSignal.timeout(options.readyTimeoutMs ?? 10_000), ...(options.signal ? [options.signal] : [])]);
  try {
    return (await dockerCli(options.docker ?? "docker", ["container", "inspect", "--format", "{{.State.Running}}", sandboxName(documentId)], deadline)).trim() === "true";
  } catch (err) {
    if (String(err).includes("No such container")) return false;
    throw err;
  }
}

/**
 * The reaper: removes every sandbox whose document is not in use, running or not, and its network, and
 * returns those documents. Only its own pool's. `inUse` asks Postgres: the truth is there, and a
 * container is only a cache of it. Removed, never merely stopped: a stopped container still holds its
 * network, and one of the daemon's few address pools with it.
 *
 * The containers and networks are listed FIRST, then Postgres is asked. The other order races a start:
 * "not in use" is read, a job starts the document's sandbox, the list then includes it, and it is
 * removed mid-start. This way a listed one was there before the answer, which covers any job that made it.
 */
export async function reapSandboxes(inUse: () => Promise<ReadonlySet<string>>, options: SandboxOptions): Promise<string[]> {
  checkPool(options.pool);
  const deadline = AbortSignal.any([AbortSignal.timeout(options.readyTimeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
  const run: Run = (...args) => dockerCli(options.docker ?? "docker", args, deadline);
  const format = ["--filter", `label=${LABEL}=${options.pool}`, "--format", `{{.Label "noon.document"}}`];
  const containers = (await run("ps", "--all", ...format)).split("\n");
  // A network outlives its container when a start failed between the two: swept all the same.
  const networks = (await run("network", "ls", ...format)).split("\n");
  const used = await inUse();
  // Only names this code made: a label that is not a uuid is left alone, never interpolated.
  const idle = (ids: string[]): string[] => ids.filter((id) => UUID.test(id) && !used.has(id));
  const idleContainers = idle(containers);
  const idleNetworks = idle(networks);
  if (idleContainers.length > 0) await run("rm", "--force", ...idleContainers.map(sandboxName));
  for (const id of idleNetworks) {
    // The proxy is the network's other member, and a network with a member cannot be removed.
    await run("network", "disconnect", "--force", sandboxName(id), proxyName(options.pool)).catch(() => undefined);
    await run("network", "rm", sandboxName(id)).catch((err: unknown) => {
      if (!String(err).includes("not found")) throw err;
    });
  }
  return [...new Set([...idleContainers, ...idleNetworks])];
}

/** The container's own PREVIEW_BASE, as it was created with it. */
async function baseOf(run: Run, name: string): Promise<string> {
  const env = await run("container", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", name);
  const base = env.split("\n").find((line) => line.startsWith("PREVIEW_BASE="))?.slice("PREVIEW_BASE=".length);
  if (base === undefined) throw new Error(`${name}: no PREVIEW_BASE`);
  return base;
}

/**
 * The document's own network. --internal: no route out, no host.docker.internal (which reaches the
 * api's x-dev-user, Postgres and Redis on the host's loopback), and no published port either (Docker
 * binds none for an internal-only container, measured), which is why the proxy exists. One per
 * document, not one shared with inter-container traffic off: that would cut the proxy off too (measured).
 * The clone from Gitea comes through the worker (deliverSeed), never by a route to the compose network.
 * ponytail: a network per sandbox spends one of the daemon's address pools each, about 30 by default
 * (some already taken). Ceiling: that many sandboxes at once, daemon-wide; upgrade: `default-address-pools`
 * with small subnets in the daemon's config, or explicit `--subnet`s carved from one range.
 */
async function ensureNetwork(run: Run, name: string, documentId: string, pool: string): Promise<void> {
  await run("network", "create", "--internal", "--label", `${LABEL}=${pool}`, "--label", `noon.document=${documentId}`, name).catch((err: unknown) => {
    if (!String(err).includes("already exists")) throw err; // a restart, or another process made it first
  });
}

/** Puts a container on a network; already on it is fine. */
async function join(run: Run, network: string, container: string): Promise<void> {
  await run("network", "connect", network, container).catch((err: unknown) => {
    if (!String(err).includes("already exists")) throw err;
  });
}

/**
 * The pool's proxy, once per process and key: made if missing, made anew when its program or key changed (a
 * label says which it runs), then joined to every sandbox network the pool already has. Loopback only,
 * like every port here, and confined like a sandbox: it parses what strangers send.
 */
function ensureProxy(run: Run, pool: string, image: string, key: string, port: number): Promise<void> {
  const want = fingerprint(PROXY_PROGRAM, key, String(port));
  const known = proxies.get(pool);
  if (known?.want === want) return known.made;
  const made = makeProxy(run, pool, image, key, port, want).catch((err: unknown) => {
    if (proxies.get(pool)?.made === made) proxies.delete(pool); // a failure is not remembered: the next start asks again
    throw err;
  });
  proxies.set(pool, { want, made });
  return made;
}

async function makeProxy(run: Run, pool: string, image: string, key: string, port: number, want: string): Promise<void> {
  const name = proxyName(pool);
  const seen = await run("container", "inspect", "--format", `{{.State.Running}} {{index .Config.Labels "noon.proxy"}}`, name).catch((err: unknown) => {
    if (String(err).includes("No such container")) return undefined;
    throw err;
  });
  if (seen?.trim() === `true ${want}`) return;
  if (seen !== undefined) await run("rm", "--force", name);
  try {
    await run("run", "--detach", "--name", name, "--label", `noon.proxy=${want}`, "--label", `noon.proxy-pool=${pool}`,
      "--restart", "unless-stopped", "--publish", `127.0.0.1:${String(port)}:${String(PROXY_PORT)}`, "--env", `PREVIEW_KEY=${key}`,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m",
      "--entrypoint", "node", image, "--input-type=module-typescript", "-e", PROXY_PROGRAM);
  } catch (err) {
    if (!String(err).includes("is already in use by container")) throw err; // another process made it first
  }
  const networks = (await run("network", "ls", "--filter", `label=${LABEL}=${pool}`, "--format", "{{.Name}}")).split("\n").filter(Boolean);
  for (const network of networks) await join(run, network, name);
}

/**
 * Polls the dev server from INSIDE the container. The worker runs in compose, where `localhost` is
 * not the host, and the sandbox's port is published on the host's loopback only: asking from inside
 * works wherever the caller is. node:24-slim has no curl; Node's own fetch does the job.
 *
 * Only the probe's OWN "no" (exit code 3, chosen so nothing else produces it) means "not yet". Any
 * other failure (the container is gone, the daemon is away) is an answer, and polling it for a minute
 * would only hide it.
 */
async function ready(run: Run, name: string, deadline: AbortSignal): Promise<void> {
  // Under the container's own PREVIEW_BASE (docker exec runs with the container's environment): the
  // dev server refuses every other path.
  const probe = `fetch('http://127.0.0.1:${String(CONTAINER_PORT)}' + process.env.PREVIEW_BASE).then(r => process.exit(r.ok ? 0 : 3), () => process.exit(3))`;
  for (;;) {
    try {
      await run("exec", name, "node", "-e", probe);
      return;
    } catch (err) {
      if ((err as { cause?: { code?: unknown } }).cause?.code === 3) {
        await sleep(100, undefined, { signal: deadline }); // not yet; the pause throws once the deadline passes
        continue;
      }
      // Asked, not guessed from the error: an exec that raced the container's death fails with an
      // empty stderr (measured), so "is not running" is not always there to be read.
      const running = await run("container", "inspect", "--format", "{{.State.Running}}", name).catch(() => undefined);
      if (running?.trim() === "false") {
        // It EXITED: its clone failed, or the dev server crashed. Say so now, with its last words,
        // which are on stderr as often as on stdout (git's "fatal: ..." is).
        const logs = await run("logs", "--tail", "20", name).catch(() => "");
        throw new Error(`${name} exited before it was ready: ${logs.trim()}`, { cause: err });
      }
      throw err;
    }
  }
}

/**
 * One docker CLI call, resolving with what it printed. Every one has an end from outside, the
 * start's deadline: a wedged Docker daemon makes the CLI wait for ever. The abort is handled HERE,
 * with SIGKILL, not by execFile's own `signal` option: measured on Node 24, that sends SIGTERM
 * whatever `killSignal` says, and a CLI that ignores SIGTERM then outlives the call and keeps this
 * process's event loop alive.
 */
async function dockerCli(docker: string, args: string[], deadline: AbortSignal, input?: string | Buffer): Promise<string> {
  const { stdout, stderr } = await cli(docker, args, deadline, { name: `docker ${args[0] ?? ""}`, ...(input === undefined ? {} : { input }) });
  // `docker logs` replays the container's stderr on its own: there, both streams are the answer.
  return args[0] === "logs" ? stdout.toString("utf8") + stderr : stdout.toString("utf8");
}

/** One CLI call under the deadline, as dockerCli says. `name` starts its errors. */
export function cli(file: string, args: string[], deadline: AbortSignal, options: { name: string; input?: string | Buffer; env?: NodeJS.ProcessEnv }): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (deadline.aborted) {
      reject(deadline.reason as Error);
      return;
    }
    const kill = (): void => { child.kill("SIGKILL"); };
    const child = execFile(file, args, { encoding: "buffer", maxBuffer: MAX_BUNDLE, ...(options.env ? { env: options.env } : {}) }, (err, stdout, stderr) => {
      deadline.removeEventListener("abort", kill);
      if (deadline.aborted) reject(new Error(`${options.name}: abandoned at the deadline`, { cause: deadline.reason }));
      else if (err) reject(new Error(`${options.name}: ${stderr.toString("utf8").trim() || err.message}`, { cause: err }));
      else resolve({ stdout, stderr: stderr.toString("utf8") });
    });
    deadline.addEventListener("abort", kill, { once: true });
    // A CLI that exits (or is killed) before reading all of `input` makes the write fail with EPIPE.
    // Unheard, that is an uncaught exception and the whole worker dies; the exit code already says it.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}

