import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sandboxName, startSandbox, type SandboxOptions } from "./sandbox.ts";

// E4.2a, integration:sandbox-start-ready. Real Docker, the real image, the real sample app.
const DOCKER = existsSync("/Applications/Docker.app/Contents/Resources/bin/docker") ? "/Applications/Docker.app/Contents/Resources/bin/docker" : "docker";
// `docker build` pulls the base image through a credential helper that lives next to the CLI.
const env = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:${dirname(DOCKER)}` };
const exec = (file: string, args: string[], options: { cwd?: string; timeout: number }) => promisify(execFile)(file, args, { ...options, env });
const IMAGE = "noon-sandbox:dev";
const BROKEN = "noon-sandbox:broken";
const SILENT = "noon-sandbox:silent";
const REPO = new URL("../../../", import.meta.url).pathname;
const docker = async (...args: string[]): Promise<string> => (await exec(DOCKER, args, { timeout: 60_000 })).stdout.trim();
const options: SandboxOptions = { image: IMAGE, docker: DOCKER, ports: [21000, 21999] };
const made: string[] = [];
const newDocument = (): string => {
  const id = randomUUID();
  made.push(id);
  return id;
};

beforeAll(async () => {
  // Cached after the first build (which takes minutes: it installs the sample app's dependencies).
  await exec(DOCKER, ["build", "--quiet", "--tag", IMAGE, "--file", "apps/worker/sandbox/Dockerfile", "seed/sample-app"], { cwd: REPO, timeout: 900_000 });
  // The same image, pointed at a seed repo that does not exist: its clone fails and it exits.
  await variant(BROKEN, "ENV SEED_REPO=/nowhere.git");
  // The same image, running but with no dev server: it never answers.
  await variant(SILENT, `CMD ["sleep", "infinity"]`);
}, 900_000);

async function variant(tag: string, line: string): Promise<void> {
  const build = promisify(execFile)(DOCKER, ["build", "--quiet", "--tag", tag, "-"], { timeout: 60_000, env });
  build.child.stdin?.end(`FROM ${IMAGE}\n${line}\n`);
  await build;
}

afterAll(async () => {
  if (made.length > 0) await docker("rm", "--force", ...made.map(sandboxName)).catch(() => undefined);
});

test("a document's sandbox starts from the baked image and reports a URL that serves the sample app", async () => {
  const id = newDocument();
  const started = Date.now();
  const sandbox = await startSandbox(id, options);
  const took = Date.now() - started;

  const page = await fetch(sandbox.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(`<div id="root">`);
  // The dev server really transforms the app's code, not only serves index.html.
  expect(await (await fetch(new URL("src/pages/Showcase.tsx", sandbox.url))).text()).toContain("Showcase");
  // Baked: nothing is installed at start. Installing took 10.6-17.7 s in the learning test; a clone
  // plus a cold Vite took about 1 s. The bound sits between the two, where it tells them apart.
  expect(took).toBeLessThan(8_000);
  await docker("exec", sandboxName(id), "test", "-d", "node_modules/vite"); // throws when it is not there
}, 60_000);

test("the sandbox works in ITS OWN clone of the seed repo, on the document's working branch", async () => {
  const [a, b] = [newDocument(), newDocument()];
  await Promise.all([startSandbox(a, options), startSandbox(b, options)]);
  const git = (id: string, ...args: string[]): Promise<string> => docker("exec", sandboxName(id), "git", ...args);
  expect(await git(a, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`noon/${a}`);
  expect(await git(a, "log", "--format=%s", "-1")).toBe("seed");
  expect(await git(a, "status", "--porcelain")).toBe(""); // baked node_modules is not a change
  // Own clone: a file written in one sandbox is not in the other.
  await docker("exec", sandboxName(a), "sh", "-c", "echo x > only-in-a.txt");
  await expect(docker("exec", sandboxName(b), "test", "-e", "only-in-a.txt")).rejects.toThrow();
}, 60_000);

/** Every caller got the SAME sandbox, and its URL reaches THIS document's container, not merely something. */
async function expectOneSandbox(id: string, results: { url: string }[]): Promise<void> {
  expect(new Set(results.map((r) => r.url)).size).toBe(1);
  expect((await docker("ps", "--all", "--quiet", "--filter", `label=noon.document=${id}`)).split("\n").filter(Boolean)).toHaveLength(1);
  await docker("exec", sandboxName(id), "sh", "-c", `echo ${id} > whoami.txt`);
  expect((await (await fetch(new URL("whoami.txt", results[0]?.url))).text()).trim()).toBe(id);
}

test("one container per document: ten concurrent starts all get the same sandbox, and its URL is really it", async () => {
  // The E4.2a verifier's race: the losers of `docker run` found the winner still starting, got
  // "port not available" from `docker start` (the winner held it) and REMOVED the winner's container.
  const id = newDocument();
  const results = await Promise.all(Array.from({ length: 10 }, () => startSandbox(id, options)));
  await expectOneSandbox(id, results);
  expect(await startSandbox(id, options)).toEqual(results[0]);
}, 90_000);

test("ten concurrent starts of a KILLED sandbox bring it back once, with its working tree", async () => {
  const id = newDocument();
  await startSandbox(id, options);
  await docker("exec", sandboxName(id), "sh", "-c", "echo kept > kept.txt");
  await docker("kill", sandboxName(id));
  const results = await Promise.all(Array.from({ length: 10 }, () => startSandbox(id, options)));
  await expectOneSandbox(id, results);
  expect(await docker("exec", sandboxName(id), "cat", "kept.txt")).toBe("kept");
}, 90_000);

test("a stopped sandbox comes back on the SAME url with its working tree, because Vite's client only self-heals on the same origin", async () => {
  const id = newDocument();
  const before = await startSandbox(id, options);
  await docker("exec", sandboxName(id), "sh", "-c", "echo kept > kept.txt");
  await docker("kill", sandboxName(id));
  const after = await startSandbox(id, options);
  expect(after.url).toBe(before.url);
  expect((await fetch(after.url)).status).toBe(200);
  expect(await docker("exec", sandboxName(id), "cat", "kept.txt")).toBe("kept");
}, 60_000);

test("a clone that died halfway is done again on the next start, not served as it is", async () => {
  const id = newDocument();
  await startSandbox(id, options);
  // What a clone killed between `git init` and `git checkout` leaves behind: a .git, and no HEAD.
  await docker("exec", sandboxName(id), "sh", "-c", `git update-ref -d refs/heads/noon/${id}`);
  await docker("kill", sandboxName(id));
  await startSandbox(id, options);
  expect(await docker("exec", sandboxName(id), "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(`noon/${id}`);
  expect(await docker("exec", sandboxName(id), "git", "log", "--format=%s", "-1")).toBe("seed");
}, 60_000);

test("a port something else holds is skipped, and the container it left behind does not block the next try", async () => {
  // Held on the host, where Docker has to bind. Two ports in the range, the first one taken.
  const held = createServer();
  // Outside the file's shared range, so no other test's sandbox can already sit on either port.
  await new Promise<void>((resolve) => held.listen(22990, "127.0.0.1", resolve));
  try {
    // An id whose first eight hex digits are 0 starts at the FIRST port of the range: the held one.
    const id = `00000000-${randomUUID().slice(9)}`;
    made.push(id);
    const sandbox = await startSandbox(id, { ...options, ports: [22990, 22991] });
    expect(sandbox.url).toBe("http://127.0.0.1:22991/");
    // With the ONLY port held, it gives up by name instead of looping.
    await expect(startSandbox(newDocument(), { ...options, ports: [22990, 22990] })).rejects.toThrow(/no free port/u);
  } finally {
    held.close();
  }
}, 60_000);

test("the URL names the address the port is bound to, so a listener on ::1 cannot answer for it", async () => {
  // `localhost` may resolve to ::1 first, where Docker did not bind and anything else may listen.
  expect((await startSandbox(newDocument(), options)).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
}, 60_000);

test("the container is confined: loopback-only port, no root, no capabilities, no swap, a small /tmp, its own network", async () => {
  const id = newDocument();
  await startSandbox(id, options);
  const inspect = JSON.parse(await docker("container", "inspect", sandboxName(id))) as [{ HostConfig: { PortBindings: Record<string, { HostIp: string }[]>; CapDrop: string[]; SecurityOpt: string[]; Memory: number; MemorySwap: number; Tmpfs: Record<string, string>; NetworkMode: string; Init: boolean } }];
  const config = inspect[0].HostConfig;
  expect(Object.values(config.PortBindings).flat().map((binding) => binding.HostIp)).toEqual(["127.0.0.1"]);
  expect(config.CapDrop).toEqual(["ALL"]);
  expect(config.SecurityOpt).toContain("no-new-privileges");
  expect(config.MemorySwap).toBe(config.Memory); // equal = no swap on top of the memory limit
  expect(config.Tmpfs["/tmp"]).toMatch(/size=/u);
  expect(config.NetworkMode).toBe("noon-sandboxes");
  expect(await docker("exec", sandboxName(id), "id", "-u")).not.toBe("0");
}, 60_000);

test("one sandbox cannot reach another's dev server", async () => {
  const [a, b] = [newDocument(), newDocument()];
  await Promise.all([startSandbox(a, options), startSandbox(b, options)]);
  const ip = await docker("container", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", sandboxName(b));
  expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
  const probe = `fetch('http://${ip}:5173/', { signal: AbortSignal.timeout(2000) }).then(() => console.log('reached'), () => console.log('refused'))`;
  expect(await docker("exec", sandboxName(a), "node", "-e", probe)).toBe("refused");
}, 60_000);

test("docker stop takes a sandbox down at once, not after the 10 s grace (Vite handles SIGTERM itself: no --init needed)", async () => {
  const id = newDocument();
  await startSandbox(id, options);
  const started = Date.now();
  await docker("stop", sandboxName(id));
  expect(Date.now() - started).toBeLessThan(5_000);
}, 60_000);

test.each(["not-a-uuid", "--upload-pack=touch /tmp/pwned", `${randomUUID()} `, randomUUID().toUpperCase()])("a document id that is not a plain uuid never reaches docker: %j", async (id) => {
  await expect(startSandbox(id, { ...options, docker: "/nonexistent/docker" })).rejects.toThrow(/not a document id/u);
});

test("a docker that never answers is abandoned at the deadline, and a cancelled start ends at once", async () => {
  // A wedged daemon: the CLI takes the arguments and waits for ever. Only the deadline ends it.
  const hung = join(mkdtempSync(join(tmpdir(), "hung-docker-")), "docker");
  writeFileSync(hung, "#!/bin/sh\nexec sleep 3600\n", { mode: 0o755 });
  const started = Date.now();
  await expect(startSandbox(randomUUID(), { ...options, docker: hung, readyTimeoutMs: 500 })).rejects.toThrow(/not ready within 500 ms/u);
  expect(Date.now() - started).toBeLessThan(3_000);
  await expect(startSandbox(randomUUID(), { ...options, signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/u);
});

test("a docker CLI that ignores SIGTERM is killed anyway, not left running when the start gives up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stubborn-docker-"));
  const stubborn = join(dir, "docker");
  // `trap '' TERM` is inherited across exec: this sleep cannot be ended politely.
  writeFileSync(stubborn, `#!/bin/sh\necho $$ > ${dir}/pid\ntrap '' TERM\nexec sleep 3600\n`, { mode: 0o755 });
  // 3 s, not 0.5: macOS scans a brand-new executable on its first run, and a stub killed before it
  // ever ran would prove nothing (measured: no pid file at 300 ms).
  await expect(startSandbox(randomUUID(), { ...options, docker: stubborn, readyTimeoutMs: 3_000 })).rejects.toThrow(/not ready within/u);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(() => process.kill(pid, 0)).toThrow(); // ESRCH: no such process
});

test("a sandbox that runs but never answers is given up at the deadline, not polled for ever", async () => {
  const id = newDocument();
  const started = Date.now();
  await expect(startSandbox(id, { ...options, image: SILENT, readyTimeoutMs: 3_000 })).rejects.toThrow(/not ready within 3000 ms/u);
  expect(Date.now() - started).toBeLessThan(8_000);
}, 30_000);

test("a sandbox removed while it is starting fails the start at once, by name, instead of polling out the deadline", async () => {
  const id = newDocument();
  const started = Date.now();
  const start = startSandbox(id, { ...options, image: SILENT, readyTimeoutMs: 30_000 });
  setTimeout(() => void docker("rm", "--force", sandboxName(id)).catch(() => undefined), 1500);
  await expect(start).rejects.toThrow(/No such container|is not running|exited before it was ready/u);
  expect(Date.now() - started).toBeLessThan(8_000);
}, 60_000);

test("a sandbox whose dev server can never start says so at once, with its logs, instead of waiting out the deadline", async () => {
  const id = newDocument();
  const started = Date.now();
  // Its last words are git's, on STDERR: "fatal: '/nowhere.git' does not appear to be a git repository".
  await expect(startSandbox(id, { ...options, image: BROKEN, readyTimeoutMs: 30_000 })).rejects.toThrow(/exited before it was ready: .*nowhere\.git/su);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 60_000);
