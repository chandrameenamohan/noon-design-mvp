import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The sandbox: one container per document working branch, running the sample app's own dev server
 * (apps/worker/sandbox/Dockerfile). This file STARTS one and says where it answers. Pushing the
 * generated file into it and reaping idle ones is E4.2b.
 *
 * Docker is the registry. The container's NAME is the document's, so "one per document" is Docker's
 * own name uniqueness, which is atomic: two starts that race cannot make two containers. There is no
 * table to fall out of step with what is actually running.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CONTAINER_PORT = 5173;
const LABEL = "noon.sandbox";
/** What Docker says when the host port is taken: by another container, or (Docker Desktop) by a host process. */
const PORT_TAKEN = /port is already allocated|address already in use|ports are not available/u;

export type Sandbox = { container: string; url: string };
export type SandboxOptions = {
  image: string;
  /** The docker CLI. Docker Desktop does not always put it on PATH. */
  docker?: string;
  /** Host ports to choose from, inclusive. */
  ports?: readonly [number, number];
  /** The whole start, first docker call to first HTTP 200. */
  readyTimeoutMs?: number;
  /** Aborted = give up now (the job was cancelled, or the worker is stopping). */
  signal?: AbortSignal;
};

export const sandboxName = (documentId: string): string => `noon-sandbox-${documentId}`;

/**
 * Starts the document's sandbox, or finds the one already running, and resolves once its dev
 * server answers. Safe to call again at any time: a running sandbox is returned as it is, a stopped
 * one is started again WITH ITS WORKING TREE and ON ITS OLD PORT.
 *
 * The port never changes for the life of the container, and that is a requirement, not tidiness:
 * after a restart Vite's client reloads the page by itself, but only if the new server answers on
 * the SAME origin (SPEC §2a). Docker's own port choice (`-p 127.0.0.1::5173`) is re-rolled on every
 * `docker start` (measured: 49755, then 49767), so the port is chosen here, once, and written into
 * the container's own configuration.
 */
export async function startSandbox(documentId: string, options: SandboxOptions): Promise<Sandbox> {
  // The id becomes a container name, a label and a git branch. execFile has no shell, but a
  // branch called `--upload-pack=...` is still an argument. Only a plain uuid gets past here.
  if (!UUID.test(documentId)) throw new Error(`not a document id: ${JSON.stringify(documentId)}`);
  const { image, docker = "docker", ports = [20000, 20999], readyTimeoutMs = 60_000 } = options;
  const deadline = AbortSignal.any([AbortSignal.timeout(readyTimeoutMs), ...(options.signal ? [options.signal] : [])]);
  const run = (...args: string[]): Promise<string> => dockerCli(docker, args, deadline);
  const name = sandboxName(documentId);

  // Candidates step through the range from a start taken from the document id: spread, so two
  // documents rarely want the same port, and stepping, so a taken port is never tried twice.
  const size = ports[1] - ports[0] + 1;
  const offset = Number.parseInt(documentId.slice(0, 8), 16) % size;
  let port: number | undefined;
  for (let attempt = 0; port === undefined; attempt++) {
    if (attempt === 5) throw new Error(`${name}: no free port after ${String(attempt)} tries`);
    port = await existing(run, name);
    if (port !== undefined) break;
    const candidate = ports[0] + ((offset + attempt) % size);
    try {
      await run("run", "--detach", "--name", name,
        "--label", `${LABEL}=1`, "--label", `noon.document=${documentId}`,
        "--env", `BRANCH=noon/${documentId}`,
        // Loopback only: a laptop on a shared network must not serve its previews to the room.
        "--publish", `127.0.0.1:${String(candidate)}:${String(CONTAINER_PORT)}`,
        // It runs code nobody here wrote (the customer's repo) and code generated from user input.
        // ponytail: egress is open (Vite needs none); an internal network cannot publish a port, so
        // closing it means a proxy in front. Do that before a sandbox ever runs a stranger's repo.
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1g", "--cpus", "1",
        image);
      port = candidate;
    } catch (err) {
      const message = String(err);
      // Somebody else created it between our look and our run: theirs is the one. Look again.
      if (message.includes("is already in use by container")) continue;
      // `docker run` CREATES the container before it binds the port, so a port that turns out to be
      // taken leaves a container behind under the document's name. The next turn's `existing()`
      // finds it, fails to start it for the same reason, and removes it; then the next port is tried.
      if (PORT_TAKEN.test(message)) continue;
      throw err;
    }
  }

  await ready(run, name, deadline);
  // ponytail: `localhost` is the address a browser on THIS machine dials; a remote viewer needs the
  // canvas's own host here (and a proxy, see above).
  return { container: name, url: `http://localhost:${String(port)}/` };
}

/** The port of the document's container if there is one, started again if it was stopped. */
async function existing(run: (...args: string[]) => Promise<string>, name: string): Promise<number | undefined> {
  let inspected: string;
  try {
    inspected = await run("container", "inspect", "--format", `{{.State.Running}} {{(index (index .HostConfig.PortBindings "${String(CONTAINER_PORT)}/tcp") 0).HostPort}}`, name);
  } catch (err) {
    if (String(err).includes("No such container")) return undefined;
    throw err;
  }
  const [running, port] = inspected.trim().split(" ");
  if (running !== "true") {
    try {
      await run("start", name);
    } catch (err) {
      // Its port has been taken while it was stopped. The working tree goes with it: a fresh clone
      // on a new port beats a sandbox that can never start. (The document is the truth; E4.2b pushes
      // the generated file into whichever container answers.)
      if (!PORT_TAKEN.test(String(err))) throw err;
      await run("rm", "--force", name);
      return undefined;
    }
  }
  return Number(port);
}

/**
 * Polls the dev server from INSIDE the container. The worker runs in compose, where `localhost` is
 * not the host, and the sandbox's port is published on the host's loopback only: asking from inside
 * works wherever the caller is. node:24-slim has no curl; Node's own fetch does the job.
 */
async function ready(run: (...args: string[]) => Promise<string>, name: string, deadline: AbortSignal): Promise<void> {
  const probe = `fetch('http://127.0.0.1:${String(CONTAINER_PORT)}/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))`;
  for (;;) {
    try {
      await run("exec", name, "node", "-e", probe);
      return;
    } catch (err) {
      // A container that has EXITED will never answer: its clone failed, or the dev server crashed.
      // Say so now, with its last words, rather than wait out the deadline.
      if (String(err).includes("is not running")) {
        const logs = await run("logs", "--tail", "20", name).catch(() => "");
        throw new Error(`${name} exited before it was ready: ${logs.trim()}`, { cause: err });
      }
    }
    // The loop's only way out when the server never answers: the pause throws once the deadline passes.
    await sleep(100, undefined, { signal: deadline });
  }
}

/**
 * One docker CLI call. Every one has an end from outside, the start's deadline: a wedged Docker
 * daemon makes the CLI wait for ever, and aborting the signal kills the child process.
 */
function dockerCli(docker: string, args: string[], deadline: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(docker, args, { signal: deadline, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args[0] ?? ""}: ${stderr.trim() || err.message}`, { cause: err }));
      else resolve(stdout);
    });
  });
}
