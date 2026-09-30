import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium } from "@playwright/test";
import type { Doc, Op, PropValue } from "@noon/contracts";
import { generate } from "@noon/codegen";
import { manifest } from "@noon/design-system";
import { applyOp, emptyDoc, ROOT_ID } from "@noon/doc-model";
import { buildImage, DOCKER, docker, dockerEnv, IMAGE, testPool } from "./sandbox-testing.ts";
import { isRunning, pagePath, previewUrl, pushPage, reapSandboxes, sandboxName, startSandbox, type SandboxOptions } from "./sandbox.ts";

// E4.2a, integration:sandbox-start-ready. Real Docker, the real image, the real sample app.
const BROKEN = "noon-sandbox:broken";
const SILENT = "noon-sandbox:silent";
const pool = testPool();
const options: SandboxOptions = { image: IMAGE, docker: DOCKER, pool, ports: [21000, 21999] };
const made: string[] = [];
const newDocument = (): string => {
  const id = randomUUID();
  made.push(id);
  return id;
};

beforeAll(async () => {
  await buildImage();
  // The same image, pointed at a seed repo that does not exist: its clone fails and it exits.
  await variant(BROKEN, "ENV SEED_REPO=/nowhere.git");
  // The same image, running but with no dev server: it never answers.
  await variant(SILENT, `CMD ["sleep", "infinity"]`);
}, 900_000);

async function variant(tag: string, line: string): Promise<void> {
  const build = promisify(execFile)(DOCKER, ["build", "--quiet", "--tag", tag, "-"], { timeout: 60_000, env: dockerEnv });
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
  // Baked: node_modules is IN THE IMAGE, before any container starts (a structural fact, not a
  // timing guess: an 8 s bound between "about 1 s" and "10.6 s to install" failed once under load).
  await docker("run", "--rm", "--entrypoint", "test", IMAGE, "-d", "/app/node_modules/vite"); // throws when it is not there
  expect(took).toBeLessThan(30_000); // a smoke bound only
}, 60_000);

test("the sandbox works in ITS OWN clone of the seed repo, on the document's working branch", async () => {
  const [a, b] = [newDocument(), newDocument()];
  await Promise.all([startSandbox(a, options), startSandbox(b, options)]);
  const git = (id: string, ...args: string[]): Promise<string> => docker("exec", sandboxName(id), "git", ...args);
  expect(await git(a, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`noon/${a}`);
  expect(await git(a, "log", "--format=%s", "-1")).toBe("seed");
  // Baked node_modules and the preview entry are not changes; the document's own page is the one new file.
  expect(await git(a, "status", "--porcelain")).toBe(`?? ${pagePath(a)}`);
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
  const nowhere = { ...options, docker: "/nonexistent/docker" };
  await expect(startSandbox(id, nowhere)).rejects.toThrow(/not a document id/u);
  await expect(pushPage(id, "export function Page() { return null; }", nowhere)).rejects.toThrow(/not a document id/u);
  await expect(isRunning(id, nowhere)).rejects.toThrow(/not a document id/u);
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

// --- E4.2b: integration:sandbox-push-hot-update, integration:sandbox-reap -------------------------

const add = (nodeId: string, parentId: string, component: string, props: Record<string, PropValue> = {}, index = 0): Op => ({ type: "add_node", nodeId, parentId, index, component, props });
/** The file codegen makes for a small form whose Text says `text`. Same tree every time, only the words differ. */
function page(text: string): string {
  const doc: Doc = [add("s", ROOT_ID, "Stack"), add("i", "s", "Input", { label: "Name" }), add("t", "s", "Text", { value: text }, 1)].reduce(applyOp, emptyDoc());
  const result = generate(doc, manifest);
  if (!result.ok) throw new Error(result.reason);
  return result.tsx;
}

test("a pushed page hot-updates in the browser within 3 s: no reload, and what the user typed is still there", async () => {
  const id = newDocument();
  const sandbox = await startSandbox(id, options);
  await pushPage(id, page("first"), options);
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    // A URL naming ANOTHER document (a stale iframe, reconnected to a port this sandbox took over)
    // gets no page: one document's preview never shows another's.
    await tab.goto(previewUrl(sandbox.url, randomUUID()));
    await tab.getByText("This preview belongs to another document").waitFor();
    expect(await tab.getByText("first").count()).toBe(0);
    await tab.goto(previewUrl(sandbox.url, id));
    await tab.getByText("first").waitFor();
    // Two witnesses that the page was NOT reloaded: a value only this page load holds, and a
    // navigation event that a reload would fire. Plus the state a user would lose: typed text.
    await tab.evaluate(() => { (globalThis as { marker?: number }).marker = 42; });
    await tab.getByLabel("Name").fill("typed by a person");
    let navigated = false;
    tab.on("framenavigated", (frame) => { if (frame === tab.mainFrame()) navigated = true; });

    const pushed = Date.now();
    await pushPage(id, page("second"), options);
    await tab.getByText("second").waitFor({ timeout: 3_000 });
    expect(Date.now() - pushed).toBeLessThan(3_000);
    expect(await tab.evaluate(() => (globalThis as { marker?: number }).marker)).toBe(42);
    expect(navigated).toBe(false);
    expect(await tab.getByLabel("Name").inputValue()).toBe("typed by a person");
    // Fast Refresh, not a fresh file: the document's page in the clone is exactly what was pushed.
    expect(await docker("exec", sandboxName(id), "cat", pagePath(id))).toBe(page("second").trimEnd());
  } finally {
    await browser.close();
  }
}, 90_000);

test("the preview renders inside the canvas's sandboxed iframe (an opaque origin), and no other site may read the dev server", async () => {
  const id = newDocument();
  const sandbox = await startSandbox(id, options);
  await pushPage(id, page("framed"), options);
  const url = previewUrl(sandbox.url, id);
  // Vite answers module requests only to origins its cors allows. The frame's origin is "null"
  // (sandbox without allow-same-origin): allowed. A real site's origin: not echoed, so its reads fail.
  const allowed = async (origin: string): Promise<string | null> => (await fetch(new URL("/noon-preview/main.tsx", sandbox.url), { headers: { origin } })).headers.get("access-control-allow-origin");
  expect(await allowed("null")).toBe("null");
  expect(await allowed("http://evil.example")).not.toBe("http://evil.example");
  expect(await allowed("http://localhost:5173")).not.toBe("http://localhost:5173"); // Vite's default allowed any localhost

  const canvas = createHttpServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(`<iframe title="preview" sandbox="allow-scripts" src="${url}"></iframe>`); });
  await new Promise<void>((resolve) => canvas.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    const port = (canvas.address() as { port: number }).port;
    await tab.goto(`http://localhost:${String(port)}/`); // another origin than the preview's, as the canvas is
    await tab.frameLocator("iframe[title=preview]").getByText("framed").waitFor({ timeout: 30_000 });
  } finally {
    await browser.close();
    canvas.close();
  }
}, 90_000);

/**
 * The customer's repo owns its vite.config, and ours is wrapped around it. These are the ways a config
 * could hand the dev server's source to any site (found by the E4.3 verifier, which broke the first
 * version with the first two): the opaque-origin rule must survive all of them.
 */
const HOSTILE_CONFIGS = {
  "server.headers": `export default { server: { host: true, headers: { "Access-Control-Allow-Origin": "*" } } };`,
  "a plugin that echoes the origin": `export default { server: { host: true }, plugins: [{ name: "x", configureServer(s) { s.middlewares.use((req, res, next) => { res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*"); next(); }); } }] };`,
  "a plugin that serves the file itself with writeHead": `export default { server: { host: true }, plugins: [{ name: "x", configureServer(s) { s.middlewares.use((req, res, next) => { if (!req.url.includes("main.tsx")) return next(); res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }); res.end("export default 1"); }); } }] };`,
  "cors wide open": `export default { server: { host: true, cors: { origin: "*" } } };`,
};

test.each(Object.entries(HOSTILE_CONFIGS))("a customer vite.config cannot open the preview to other sites: %s", async (_name, config) => {
  const id = newDocument();
  const sandbox = await startSandbox(id, options);
  await pushPage(id, page("guarded"), options);
  const onHost = join(mkdtempSync(join(tmpdir(), "hostile-config-")), "vite.config.ts");
  writeFileSync(onHost, config);
  await docker("cp", onHost, `${sandboxName(id)}:/app/vite.config.ts`);
  await docker("restart", sandboxName(id));
  const answers = async (origin: string): Promise<string | null> => {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(new URL("/noon-preview/main.tsx", sandbox.url), { headers: { origin } }).catch(() => undefined);
      if (res?.ok) return res.headers.get("access-control-allow-origin");
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the dev server never came back after the restart");
  };
  expect(await answers("http://evil.example")).toBe("null");
  expect(await answers("null")).toBe("null");
}, 120_000);

test("a sandbox that was never started is simply not running: an answer, not an error", async () => {
  expect(await isRunning(randomUUID(), options)).toBe(false);
});

test("a docker that exits without reading the page fails the push, and cannot crash the process (EPIPE)", async () => {
  // Bigger than a pipe's buffer: the write is still in flight when the CLI is gone.
  const quitter = join(mkdtempSync(join(tmpdir(), "quitting-docker-")), "docker");
  writeFileSync(quitter, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(pushPage(randomUUID(), "x".repeat(4 * 1024 * 1024), { ...options, docker: quitter })).rejects.toThrow(/docker exec/u);
  await new Promise((r) => setTimeout(r, 200)); // an unhandled EPIPE would surface here and fail the file
});

test("a push to a sandbox that is not running fails by name, never silently", async () => {
  await expect(pushPage(newDocument(), page("x"), options)).rejects.toThrow(/No such container|is not running/u);
});

test("the reaper sweeps only its own pool: another stack's sandbox, not in use HERE, is left alone", async () => {
  // The compose stack's reaper once removed the test suite's sandboxes: same daemon, same label.
  const theirs = newDocument();
  await startSandbox(theirs, { ...options, pool: testPool() });
  expect(await reapSandboxes(() => Promise.resolve(new Set()), options)).not.toContain(theirs);
  expect(await isRunning(theirs, options)).toBe(true);
}, 60_000);

test("the reaper lists the containers BEFORE it asks what is in use: a sandbox started in between is never removed", async () => {
  // The race: Postgres answers "not in use", a job starts the document's sandbox, THEN docker ps lists it.
  const own = { ...options, pool: testPool() };
  const late = newDocument();
  const removed = await reapSandboxes(async () => {
    await startSandbox(late, own); // started after the list, so it is not in it
    return new Set<string>(); // ...and the in-use answer predates its job
  }, own);
  expect(removed).not.toContain(late);
  expect(await isRunning(late, own)).toBe(true);
}, 60_000);

test.each(["", "Has Space", "a".repeat(41), "x=y"])("a pool name that could escape its label is refused: %j", async (bad) => {
  await expect(startSandbox(randomUUID(), { ...options, pool: bad })).rejects.toThrow(/pool/u);
  await expect(reapSandboxes(() => Promise.resolve(new Set()), { ...options, pool: bad })).rejects.toThrow(/pool/u);
});

// Last on purpose: the reaper removes EVERY sandbox of its pool not in use, the other tests' ones too.
test("the reaper removes every sandbox whose document is not in use, and only those", async () => {
  const [inUse, idle] = [newDocument(), newDocument()];
  await Promise.all([startSandbox(inUse, options), startSandbox(idle, options)]);
  const removed = await reapSandboxes(() => Promise.resolve(new Set([inUse])), options);
  expect(removed).toContain(idle);
  expect(removed).not.toContain(inUse);
  const left = (await docker("ps", "--all", "--filter", `label=noon.sandbox=${pool}`, "--format", `{{.Label "noon.document"}}`)).split("\n").filter(Boolean);
  expect(left).toEqual([inUse]);
  // A second sweep with nothing idle removes nothing.
  expect(await reapSandboxes(() => Promise.resolve(new Set([inUse])), options)).toEqual([]);
}, 90_000);

test("the reaper leaves alone a container it did not name, even one wearing the sandbox label", async () => {
  const stranger = `stranger-${randomUUID()}`;
  await docker("run", "--detach", "--name", stranger, "--label", `noon.sandbox=${pool}`, "--label", "noon.document=not-a-uuid", SILENT);
  try {
    expect(await reapSandboxes(() => Promise.resolve(new Set()), options)).not.toContain("not-a-uuid");
    expect(await docker("container", "inspect", "--format", "{{.Name}}", stranger)).toBe(`/${stranger}`);
  } finally {
    await docker("rm", "--force", stranger);
  }
}, 90_000);
