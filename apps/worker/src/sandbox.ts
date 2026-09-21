import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

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
/** Sandboxes live here, not on the default bridge: inter-container traffic off, so one cannot read another's dev server. */
const NETWORK = "noon-sandboxes";
/** What Docker says when the host port is taken: by another container, or (Docker Desktop: "Ports are not available") by a host process. */
const PORT_TAKEN = /port is already allocated|address already in use|ports are not available/iu;

export type Sandbox = { container: string; url: string };
export type SandboxOptions = {
  image: string;
  /**
   * Whose sandboxes these are: the label every container carries, and the only ones a reaper with
   * the same pool may remove. The compose stack, `make clean-clone` and each test file share one
   * Docker daemon; without this, one stack's reaper removed another's sandboxes (it happened).
   */
  pool: string;
  /** The docker CLI. Docker Desktop does not always put it on PATH. */
  docker?: string;
  /** Host ports to choose from, inclusive. */
  ports?: readonly [number, number];
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

const starting = new Map<string, Promise<Sandbox>>();
let network: Promise<void> | undefined;

/**
 * Starts the document's sandbox, or finds the one already running, and resolves once its dev
 * server answers. Safe to call again at any time: a running sandbox is returned as it is, a stopped
 * one is started again WITH ITS WORKING TREE and ON ITS OLD PORT.
 *
 * The port never changes while the container exists, and that is a requirement, not tidiness:
 * after a restart Vite's client reloads the page by itself, but only if the new server answers on
 * the SAME origin (SPEC §2a). Docker's own port choice (`-p 127.0.0.1::5173`) is re-rolled on every
 * `docker start` (measured: 49755, then 49767), so the port is chosen here, once, and written into
 * the container's own configuration. (A STOPPED container does not hold its port, though: if
 * something takes it meanwhile, the sandbox comes back fresh on another one. Callers must read the
 * URL from the result every time, never keep the first one.)
 */
export function startSandbox(documentId: string, options: SandboxOptions): Promise<Sandbox> {
  // The id becomes a container name, a label and a git branch. execFile has no shell, but a
  // branch called `--upload-pack=...` is still an argument. Only a plain uuid gets past here.
  if (!UUID.test(documentId)) return Promise.reject(new Error(`not a document id: ${JSON.stringify(documentId)}`));
  if (!POOL.test(options.pool)) return Promise.reject(new Error(`not a sandbox pool name: ${JSON.stringify(options.pool)}`));
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
  const { image, docker = "docker", ports = [20000, 20999], readyTimeoutMs = 60_000 } = options;
  const deadline = AbortSignal.any([AbortSignal.timeout(readyTimeoutMs), ...(options.signal ? [options.signal] : [])]);
  const run: Run = (...args) => dockerCli(docker, args, deadline);
  const name = sandboxName(documentId);
  try {
    await ensureNetwork(run);
    await create(run, name, documentId, image, ports, options.pool);
    await ready(run, name, deadline);
    // The port is read AFTER the dev server answered, from the container that answered: never a
    // number remembered from before a restart that somebody else may have finished differently.
    return { container: name, url: `http://127.0.0.1:${String(await portOf(run, name))}/` };
  } catch (err) {
    // A deadline or a cancel ends every docker call with the same anonymous AbortError; say which.
    if (options.signal?.aborted) throw new Error(`${name}: start cancelled`, { cause: err });
    if (deadline.aborted) throw new Error(`${name}: not ready within ${String(readyTimeoutMs)} ms`, { cause: err });
    throw err;
  }
}

/** Makes sure the container exists and is running: started again if stopped, created if missing. */
async function create(run: Run, name: string, documentId: string, image: string, ports: readonly [number, number], pool: string): Promise<void> {
  // Candidates step through the range from a start taken from the document id: spread, so two
  // documents rarely want the same port, and stepping, so a taken port is never tried twice.
  const size = ports[1] - ports[0] + 1;
  const offset = Number.parseInt(documentId.slice(0, 8), 16) % size;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await restarted(run, name)) return;
    const candidate = ports[0] + ((offset + attempt) % size);
    try {
      await run("run", "--detach", "--name", name,
        "--label", `${LABEL}=${pool}`, "--label", `noon.document=${documentId}`,
        "--env", `BRANCH=noon/${documentId}`, "--env", `PAGE=${pagePath(documentId)}`,
        // Loopback only: a laptop on a shared network must not serve its previews to the room.
        "--publish", `127.0.0.1:${String(candidate)}:${String(CONTAINER_PORT)}`,
        "--network", NETWORK,
        // It runs code nobody here wrote (the customer's repo) and code generated from user input.
        // ponytail: egress (and host.docker.internal) is open, and the working tree's disk is not
        // capped. Both close behind the sandbox proxy (bead noon-9gz), before E5 runs a customer repo.
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
        "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--tmpfs", "/tmp:size=64m",
        image);
      return;
    } catch (err) {
      // `docker run` CREATES the container before it binds the port, so a port that turns out to be
      // taken leaves a container behind under the document's name. The next turn's `restarted()`
      // finds it, fails to start it for the same reason, and removes it; then the next port is tried.
      // A name conflict means another process created it: the next turn finds that one.
      if (!PORT_TAKEN.test(String(err)) && !String(err).includes("is already in use by container")) throw err;
    }
  }
  throw new Error(`${name}: no free port after 5 tries`);
}

/** True when the container exists and is now running; false when there is none (any leftover removed). */
async function restarted(run: Run, name: string): Promise<boolean> {
  let running: string;
  try {
    running = (await run("container", "inspect", "--format", "{{.State.Running}}", name)).trim();
  } catch (err) {
    if (String(err).includes("No such container")) return false;
    throw err;
  }
  if (running === "true") return true;
  try {
    await run("start", name);
    return true;
  } catch (err) {
    // Its port was taken while it was stopped. The working tree goes with it: a fresh clone on a new
    // port beats a sandbox that can never start. Safe only because no one else is starting this
    // document right now (see the top of the file): otherwise "taken" may mean taken by ITSELF.
    if (!PORT_TAKEN.test(String(err))) throw err;
    await run("rm", "--force", name);
    return false;
  }
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
 * The reaper: removes every sandbox whose document is not in `inUse`, running or not, and returns
 * those documents. Only its own pool's. The caller asks Postgres which documents are in use: the truth is there, and a
 * container is only a cache of it. Removed, never merely stopped: a stopped container gives up its
 * port, and a sandbox restarted on a different port breaks the open iframe's self-healing.
 */
export async function reapSandboxes(inUse: ReadonlySet<string>, options: SandboxOptions): Promise<string[]> {
  checkPool(options.pool);
  const deadline = AbortSignal.any([AbortSignal.timeout(options.readyTimeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
  const docker = options.docker ?? "docker";
  const listed = await dockerCli(docker, ["ps", "--all", "--filter", `label=${LABEL}=${options.pool}`, "--format", `{{.Label "noon.document"}}`], deadline);
  // Only names this code made: a label that is not a uuid is left alone, never interpolated.
  const idle = listed.split("\n").filter((id) => UUID.test(id) && !inUse.has(id));
  if (idle.length > 0) await dockerCli(docker, ["rm", "--force", ...idle.map(sandboxName)], deadline);
  return idle;
}

async function portOf(run: Run, name: string): Promise<number> {
  return Number(await run("container", "inspect", "--format", `{{(index (index .HostConfig.PortBindings "${String(CONTAINER_PORT)}/tcp") 0).HostPort}}`, name));
}

/** Once per process. `enable_icc=false`: containers on this network cannot open connections to each other. */
function ensureNetwork(run: Run): Promise<void> {
  network ??= run("network", "inspect", NETWORK).then(
    () => undefined,
    () => run("network", "create", "--opt", "com.docker.network.bridge.enable_icc=false", NETWORK).then(() => undefined, (err: unknown) => {
      if (!String(err).includes("already exists")) throw err; // another process made it first
    }),
  ).catch((err: unknown) => {
    network = undefined; // a failure is not remembered: the next start asks again
    throw err;
  });
  return network;
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
  const probe = `fetch('http://127.0.0.1:${String(CONTAINER_PORT)}/').then(r => process.exit(r.ok ? 0 : 3), () => process.exit(3))`;
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
function dockerCli(docker: string, args: string[], deadline: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (deadline.aborted) {
      reject(deadline.reason as Error);
      return;
    }
    const kill = (): void => { child.kill("SIGKILL"); };
    const child = execFile(docker, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      deadline.removeEventListener("abort", kill);
      if (deadline.aborted) reject(new Error(`docker ${args[0] ?? ""}: abandoned at the deadline`, { cause: deadline.reason }));
      else if (err) reject(new Error(`docker ${args[0] ?? ""}: ${stderr.trim() || err.message}`, { cause: err }));
      // `docker logs` replays the container's stderr on its own: there, both streams are the answer.
      else resolve(args[0] === "logs" ? stdout + stderr : stdout);
    });
    deadline.addEventListener("abort", kill, { once: true });
    child.stdin?.end(input);
  });
}

