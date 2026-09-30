import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Job } from "@noon/db";
import { manifest } from "@noon/design-system";
import { connect, TEST_ORG, TEST_SECRET, useSyncServer, type TestPeer } from "../../sync/src/testing.ts";
import { createPreviewHandler } from "./preview.ts";
import { pagePath, PREVIEW_PATH, sandboxName, type SandboxOptions } from "./sandbox.ts";
import { buildImage, DOCKER, docker, IMAGE, testPool } from "./sandbox-testing.ts";

// E4.2b: the `sandbox` queue's handler. The REAL sync server, the REAL peer-client, a REAL container.
const ctx = useSyncServer();
// A sync server that knows no document: every peer, the handler's included, is closed for good (4404).
const nowhere = useSyncServer({ store: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() } });
const sandbox: Omit<SandboxOptions, "signal"> = { image: IMAGE, docker: DOCKER, pool: testPool(), ports: [24000, 24999] };
const made: string[] = [];
const job = (createdBy: string | undefined = randomUUID()): Job => {
  const documentId = randomUUID();
  made.push(documentId);
  return { id: randomUUID(), orgId: TEST_ORG, documentId, queue: "sandbox", input: {}, createdBy };
};
const never = new AbortController().signal;

beforeAll(buildImage, 900_000);
afterAll(async () => {
  await docker("rm", "--force", ...made.map(sandboxName)).catch(() => undefined);
});

function handler(overrides: Partial<Parameters<typeof createPreviewHandler>[0]> = {}) {
  const urls: (string | null)[] = [];
  const handle = createPreviewHandler({
    sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url },
    manifest,
    sandbox,
    stopping: never,
    stillMember: () => Promise.resolve(true),
    reportUrl: (_job, url) => { urls.push(url); return Promise.resolve(); },
    idleMs: 1_000,
    ...overrides,
  });
  return { handle, urls };
}

/** A person with the document open: present (a pointer), and able to edit. */
async function person(documentId: string): Promise<TestPeer & { stop: () => void }> {
  const peer = await connect(ctx.server.url, documentId);
  const beat = (): void => { peer.sendRaw({ type: "presence", cursor: { x: 0.5, y: 0.5 }, selection: null }); };
  beat();
  const timer = setInterval(beat, 1000);
  return Object.assign(peer, { stop: () => { clearInterval(timer); peer.close(); } });
}
const add = (nodeId: string, parentId: string, component: string, props: Record<string, string | number | boolean> = {}, index = 0) =>
  ({ type: "add_node", nodeId, parentId, index, component, props }) as const;
const pageIn = (documentId: string): Promise<string> => docker("exec", sandboxName(documentId), "cat", pagePath(documentId));
async function eventually(check: () => Promise<boolean>, ms: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await check().catch(() => false)) return Date.now() - started;
    if (Date.now() - started > ms) throw new Error(`not within ${String(ms)} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the preview follows the CONFIRMED document into the sandbox within 3 s, reports its URL, and ends once everyone has left", async () => {
  const run = job();
  const human = await person(run.documentId);
  const { handle, urls } = handler();
  const ended = handle(run, never);

  await eventually(() => Promise.resolve(urls.length > 0), 30_000);
  // The document is named IN the URL: a stale iframe that reconnects to a port another document took
  // meanwhile asks that document's entry for the wrong page, and is refused (sandbox.int.test.ts).
  expect(urls[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${PREVIEW_PATH}\\?doc=${run.documentId}&started=\\d+$`, "u"));
  expect((await fetch(urls[0] ?? "")).status).toBe(200);

  human.send(add("s", "root", "Stack"));
  human.send(add("t", "s", "Text", { value: "hello from the canvas" }));
  const took = await eventually(async () => (await pageIn(run.documentId)).includes(`value={"hello from the canvas"}`), 3_000);
  expect(took).toBeLessThan(3_000);
  // Someone is here: the job stays, well past idleMs.
  const stillRunning = await Promise.race([ended.then(() => false), new Promise((r) => setTimeout(() => { r(true); }, 2_500))]);
  expect(stillRunning).toBe(true);

  human.stop();
  // Presence is forgotten after 5 s, then 1 s of nobody: the job ends by itself, as `succeeded`.
  await expect(Promise.race([ended, new Promise((_, reject) => setTimeout(() => { reject(new Error("still running")); }, 12_000))])).resolves.toBeUndefined();
}, 60_000);

test("a sandbox that dies is started again and given the current page, and the new URL is reported", async () => {
  const run = job();
  const human = await person(run.documentId);
  const urls: (string | null)[] = [];
  const pageWhenAnnounced: string[] = [];
  // Read the page AT THE MOMENT the address is announced, but only for the restart: sampling the first
  // announce too would race this test's own `docker rm --force` (an exec into a container being removed).
  let sampling = false;
  const { handle } = handler({
    aliveEveryMs: 200,
    reportUrl: async (_job, url) => {
      if (url !== null && sampling) pageWhenAnnounced.push(await pageIn(run.documentId));
      urls.push(url);
    },
  });
  const stop = new AbortController();
  const ended = handle(run, stop.signal);
  try {
    human.send(add("t", "root", "Text", { value: "before the crash" }));
    await eventually(async () => (await pageIn(run.documentId)).includes("before the crash"), 30_000);
    const reported = urls.length;

    sampling = true;
    await docker("rm", "--force", sandboxName(run.documentId));
    // Back, with the document's page (not the placeholder a fresh clone starts with), and a URL again.
    await eventually(async () => (await pageIn(run.documentId)).includes("before the crash"), 15_000);
    // In between, the URL was withdrawn: the canvas says "rebuilding" instead of framing a dead port.
    expect(urls.slice(reported)).toEqual([null, expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u)]);
    // A NEW address even on the same port: Vite cannot reconnect by itself inside the canvas's
    // opaque-origin frame (its client's SharedWorker is refused), so the canvas must load it afresh.
    expect(urls.at(-1)).not.toBe(urls[reported - 1]);
    // Announced only once the new container HOLDS the document: a frame that loaded the fresh clone's
    // empty page first could miss the push (a watcher still scanning), and stay empty for good.
    expect(pageWhenAnnounced.at(-1)).toContain("before the crash");
    expect((await fetch(urls.at(-1) ?? "")).status).toBe(200);
  } finally {
    stop.abort();
    human.stop();
    await ended;
  }
}, 60_000);

test("cancel and a stopping worker each end the job within a second, and its peer leaves the room", async () => {
  for (const which of ["cancelled", "stopping"] as const) {
    const run = job();
    const human = await person(run.documentId);
    const signal = new AbortController();
    const { handle, urls } = handler(which === "stopping" ? { stopping: signal.signal } : {});
    const ended = handle(run, which === "cancelled" ? signal.signal : never);
    await eventually(() => Promise.resolve(urls.length > 0), 30_000);
    const asked = Date.now();
    signal.abort();
    // Cancelled: it simply ends (the worker records `cancelled`). Stopping: it fails by name, like an AI run.
    if (which === "cancelled") await expect(ended).resolves.toBeUndefined();
    else await expect(ended).rejects.toMatchObject({ reason: "worker_stopped" });
    expect(Date.now() - asked).toBeLessThan(1_000);
    await eventually(() => Promise.resolve(ctx.server.peerCount(run.documentId) === 1), 2_000); // only the human is left
    human.stop();
  }
}, 90_000);

test("a worker stopping while the sandbox is still STARTING fails the job as worker_stopped, not as a broken sandbox", async () => {
  const stop = new AbortController();
  const { handle } = handler({ stopping: stop.signal, sandbox: { ...sandbox, image: "noon-sandbox:silent" } }); // never answers
  const ended = handle(job(), never);
  setTimeout(() => { stop.abort(); }, 1500);
  await expect(ended).rejects.toMatchObject({ reason: "worker_stopped" });
}, 60_000);

test("a job whose owner is gone, or is no longer a member, starts nothing", async () => {
  const { handle } = handler({ stillMember: () => Promise.resolve(false) });
  const orphan: Job = { ...job(), createdBy: undefined }; // not job(undefined): that is the default parameter
  await expect(handler().handle(orphan, never)).rejects.toMatchObject({ reason: "owner_missing" });
  const removed = job();
  await expect(handle(removed, never)).rejects.toMatchObject({ reason: "owner_missing" });
  for (const id of [orphan.documentId, removed.documentId]) {
    expect(await docker("ps", "--all", "--quiet", "--filter", `label=noon.document=${id}`)).toBe("");
  }
});

test("a sandbox that cannot start fails the job by name", async () => {
  const { handle } = handler({ sandbox: { ...sandbox, image: "noon-sandbox:does-not-exist" } });
  const failed = handle(job(), never);
  await expect(failed).rejects.toMatchObject({ reason: "sandbox_unavailable" });
  await expect(failed).rejects.toThrow(/does-not-exist/u); // the detail, for the log
}, 60_000);

test("a container that dies DURING a push is started again and given the page, not failed", async () => {
  // A docker whose first push finds the container gone: the death lands between the liveness check and the push.
  const dir = mkdtempSync(join(tmpdir(), "dying-docker-"));
  const dying = join(dir, "docker");
  writeFileSync(dying, `#!/bin/sh\nif [ "$1" = exec ] && [ "$2" = --interactive ] && [ ! -f ${dir}/died ]; then touch ${dir}/died; "${DOCKER}" rm --force "$3" >/dev/null; fi\nexec "${DOCKER}" "$@"\n`, { mode: 0o755 });
  const run = job();
  const human = await person(run.documentId);
  const { handle } = handler({ sandbox: { ...sandbox, docker: dying }, aliveEveryMs: 200 });
  const stop = new AbortController();
  const ended = handle(run, stop.signal);
  let failed: unknown;
  ended.catch((err: unknown) => { failed = err; });
  try {
    human.send(add("t", "root", "Text", { value: "after the death" }));
    await eventually(async () => {
      if (failed !== undefined) throw new Error("the job failed");
      return (await pageIn(run.documentId)).includes("after the death");
    }, 30_000);
  } finally {
    stop.abort();
    human.stop();
  }
  await expect(ended).resolves.toBeUndefined();
}, 60_000);

test("a handler whose peer is closed for good fails the job by name instead of idling out or running for ever", async () => {
  const { handle } = handler({ sessions: { secret: TEST_SECRET, syncUrl: nowhere.server.url } });
  await expect(handle(job(), never)).rejects.toMatchObject({ reason: "sync_unreachable" });
}, 60_000);
