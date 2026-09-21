import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("one container per document: a second start, even a concurrent one, returns the same sandbox", async () => {
  const id = newDocument();
  const [first, second] = await Promise.all([startSandbox(id, options), startSandbox(id, options)]);
  const third = await startSandbox(id, options);
  expect(second).toEqual(first);
  expect(third).toEqual(first);
  expect((await docker("ps", "--all", "--quiet", "--filter", `label=noon.document=${id}`)).split("\n")).toHaveLength(1);
}, 60_000);

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
  await new Promise<void>((resolve) => held.listen(21990, "127.0.0.1", resolve));
  try {
    // An id whose first eight hex digits are 0 starts at the FIRST port of the range: the held one.
    const id = `00000000-${randomUUID().slice(9)}`;
    made.push(id);
    const sandbox = await startSandbox(id, { ...options, ports: [21990, 21991] });
    expect(sandbox.url).toBe("http://localhost:21991/");
    // With the ONLY port held, it gives up by name instead of looping.
    await expect(startSandbox(newDocument(), { ...options, ports: [21990, 21990] })).rejects.toThrow(/no free port/u);
  } finally {
    held.close();
  }
}, 60_000);

test("the container is confined: loopback-only port, no root, no capabilities", async () => {
  const id = newDocument();
  await startSandbox(id, options);
  const inspect = JSON.parse(await docker("container", "inspect", sandboxName(id))) as [{ HostConfig: { PortBindings: Record<string, { HostIp: string }[]>; CapDrop: string[]; SecurityOpt: string[] } }];
  const config = inspect[0].HostConfig;
  expect(Object.values(config.PortBindings).flat().map((binding) => binding.HostIp)).toEqual(["127.0.0.1"]);
  expect(config.CapDrop).toEqual(["ALL"]);
  expect(config.SecurityOpt).toContain("no-new-privileges");
  expect(await docker("exec", sandboxName(id), "id", "-u")).not.toBe("0");
}, 60_000);

test.each(["not-a-uuid", "--upload-pack=touch /tmp/pwned", `${randomUUID()} `, randomUUID().toUpperCase()])("a document id that is not a plain uuid never reaches docker: %j", async (id) => {
  await expect(startSandbox(id, { ...options, docker: "/nonexistent/docker" })).rejects.toThrow(/not a document id/u);
});

test("a docker that never answers is abandoned at the deadline, and a cancelled start ends at once", async () => {
  // A wedged daemon: the CLI takes the arguments and waits for ever. Only the deadline ends it.
  const hung = join(mkdtempSync(join(tmpdir(), "hung-docker-")), "docker");
  writeFileSync(hung, "#!/bin/sh\nexec sleep 3600\n", { mode: 0o755 });
  const started = Date.now();
  await expect(startSandbox(randomUUID(), { ...options, docker: hung, readyTimeoutMs: 500 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(3_000);
  await expect(startSandbox(randomUUID(), { ...options, signal: AbortSignal.abort() })).rejects.toThrow();
});

test("a sandbox that runs but never answers is given up at the deadline, not polled for ever", async () => {
  const id = newDocument();
  const started = Date.now();
  await expect(startSandbox(id, { ...options, image: SILENT, readyTimeoutMs: 3_000 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(8_000);
}, 30_000);

test("a sandbox whose dev server can never start says so at once, with its logs, instead of waiting out the deadline", async () => {
  const id = newDocument();
  const started = Date.now();
  await expect(startSandbox(id, { ...options, image: BROKEN, readyTimeoutMs: 30_000 })).rejects.toThrow(/exited before it was ready/u);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 60_000);
