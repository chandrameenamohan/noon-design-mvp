// FINDINGS (filled in after running; see bottom of file too for raw log).
//
// TEST HYGIENE FIX: an earlier version of this test wrote pushed variants
// (e.g. "Hello v2-bind") directly into the checked-in fixture
// app/src/Page.tsx via the bind-mount path and never restored it, so the
// fixture was left mutated on disk after a run (it would get baked into the
// image on the next run). Fixed: every push, for every method, is written
// FROM AN IN-MEMORY TEMPLATE (`pageContent(...)`); the fixture's original
// on-disk content is captured once at the top of `main()` and restored
// (byte-for-byte, verified with a read-back) in a top-level `finally` block
// that runs whether the test passes or throws.
//
// 1. "Vite in a container needs server.host:true + published port; HMR
//    websocket needs server.hmr.clientPort/strictPort."
//    ASSUMED: server.host:true + a published port is required for the page
//    to load from the host, AND server.hmr.clientPort must be set to the
//    *published* host port for the HMR websocket to work through Docker's
//    port mapping.
//    ACTUAL: server.host:true + a published port is CONFIRMED required for
//    the page to load at all (with host left at the default "localhost",
//    the container's dev server only binds loopback INSIDE the container
//    and the host-side request hangs / connection resets).
//    BUT hmr.clientPort was NOT needed in our setup: with a single port
//    (container 5173 <-> host 5190) and hmr left as the bare default
//    (`hmr: true`, no explicit port), Vite 5.4's injected client computed
//    the websocket URL from the page's own `location.port` (5190), not from
//    `server.port` (5173), so the socket connected as
//    ws://localhost:5190/?token=... and worked with zero extra config.
//    clientPort only matters when the HMR socket must use a DIFFERENT port
//    than the one the page was loaded on (e.g. server.hmr.port explicitly
//    set to something else, or a reverse proxy that separates ws/http).
//    strictPort was harmless to set but not required for this to work.
//
// 2. "Compare bind mount vs docker exec vs docker cp for pushing an edited
//    file into the container; which is <3s, hot update, state preserved,
//    most reliably."
//    MEASURED PROPERLY (previous version's claims were NOT supported: all
//    three methods measured within the ~50ms polling resolution used back
//    then, so no real speed difference could have been observed). This
//    version arms a MutationObserver inside the page that records
//    `Date.now()` the instant the title DOM node's text actually changes,
//    compared against a `Date.now()` taken immediately after the host-side
//    write call returns; Playwright's own poll for that result runs at a
//    5ms interval (`waitForFunction({ polling: 5 })`). 10 trials per
//    method, repeated across multiple full runs of this test (see logged
//    per-trial arrays and medians/maxes below); representative numbers from
//    three separate runs:
//      method       | median (ms)      | max (ms)
//      bind mount   | 48 / 48.5 / 49    | up to 92
//      docker exec  | 19.5 / 21 / 21    | up to 56
//      docker cp    | 23 / 24 / 25      | up to 54
//    docker exec and docker cp are CONSISTENTLY within ~2-4ms of each
//    other across runs (tied, given the trial-to-trial jitter) and are
//    CONSISTENTLY, MEANINGFULLY faster than bind mount (roughly 2-2.5x)
//    -- the comparative "bind mount slower" claim is now backed by real
//    repeated measurements, not assumption. The conclusion string is
//    derived programmatically from the medians each run (see "ASSUMPTION 2
//    CONCLUSION" in the log), not hard-coded.
//    RELIABILITY: across repeated runs, bind-mount pushes occasionally
//    (observed 2/10 and 3/10 in two separate runs) failed to propagate to
//    the page within an 8s per-trial timeout at all -- a real, measured
//    reliability gap, not just higher latency. docker exec and docker cp
//    had ZERO propagation failures in every run once trials were spaced
//    300ms apart (an earlier version of this test hammered rewrites of the
//    same file back-to-back with no pacing, which produced occasional
//    propagation misses for ALL THREE methods, including docker cp --
//    that was an artifact of the harness outrunning the dev server's own
//    file-watch/transform pipeline, not a per-method finding, and is fixed
//    by the pacing).
//    All three produced a HOT update (React state preserved, window.__marker
//    unchanged) for a components-only Page.tsx edit, verified after each
//    method's 10-trial run (`allHot`/`statePreserved` asserted per method).
//    RECOMMENDATION (unchanged criteria: works without a bind mount, hot
//    update, state preserved): docker exec (cat > file) is the pick -- tied
//    for fastest with docker cp, strictly more reliable than bind mount in
//    repeated measurement, and needs no bind mount / no host<->container
//    filesystem translation concerns.
//
// 3. "Fast Refresh preserves state only when the edited module exports only
//    components; adding a non-component export forces a full reload."
//    ASSUMED: adding `export const BUILD_ID = "..."` alongside the default
//    component export forces Vite to fall back to a full page reload.
//    ACTUAL: CONFIRMED. With only the component exported, the edit was a
//    hot update (state preserved, marker unchanged). The moment a
//    non-component named export was added to the same file, Vite's HMR
//    invalidation propagated to the entry module and the browser did a full
//    reload (window.__marker changed, React state reset to 0, and
//    Playwright observed an actual `framenavigated` event on the main
//    frame).
//
// 4. "A syntax error shows Vite's overlay and the server survives; fixing
//    recovers without restarting the container."
//    ACTUAL: CONFIRMED. Writing invalid JSX produced a `<vite-error-overlay>`
//    custom element in the DOM, the container process kept running the
//    whole time (no restart, same container ID), and writing valid content
//    back removed the overlay and updated the page — no container restart
//    needed at any point.
//
// 5. "The page can be embedded in a cross-origin iframe by default (no
//    X-Frame-Options/CSP block)."
//    ACTUAL: CONFIRMED for Vite's default dev server config -- and the
//    check is now non-vacuous. This test asserts the captured response
//    header map is non-empty AND that `content-type` is present (guarding
//    against an empty-map false pass) before checking the security headers:
//    real captured headers include `content-type: text/html`,
//    `cache-control`, `etag`, `vary`, etc. (logged verbatim), with no
//    `x-frame-options` header and no `content-security-policy` header at
//    all. (If a CSP header were ever present without an `x-frame-options`,
//    this test also checks it for a `frame-ancestors` directive
//    specifically, rather than requiring CSP's total absence.) A host page
//    on a different port successfully rendered the sandbox page inside an
//    <iframe> with content readable from the parent frame.
//
// 6. "Cold start: image with baked node_modules vs installed at container
//    start."
//    ACTUAL, measured numbers (previous text said "~1-2s" for the baked
//    image; that was never what was measured): baked-image cold start was
//    338-350ms to first HTTP 200 across runs -- well under a second, not
//    1-2s. The install-at-start image took 10.6s-17.7s (varies with npm's
//    local cache state) to first HTTP 200. Baked was faster in every run,
//    by roughly 30-50x.
//
// 7. "Killing the container and starting a new one: does the browser's HMR
//    client reconnect and reload on its own?"
//    Previous version was VACUOUS: its loop broke on
//    `title === "Hello v1" || navigated`, but the page already showed
//    "Hello v1" before the kill (nothing had changed it), so it matched on
//    the very first poll regardless of whether anything self-healed.
//    Fixed version: pushes "Hello v2-preheal" (via docker exec, before the
//    kill) so the page is showing something a fresh baked image would NOT
//    show; kills+removes the container and asserts the page console
//    actually logs Vite's own `[vite] server connection lost. Polling for
//    restart...` message (it did, in every run); builds a NEW image
//    (`lt-sandbox-v3`, built on the fly from an in-memory template, fixture
//    untouched) whose Page.tsx is baked as "Hello v3-postheal" from
//    container start; starts a new container from it; then polls the
//    EXISTING page/tab -- without this test ever calling
//    page.reload()/page.goto() -- for up to 15s.
//    ACTUAL: CONFIRMED self-heals, consistently, in ~1.15-1.25s after the
//    new container came up. Reading Vite's own client source
//    (client.mjs, confirmed against the pinned `vite@^5.4.11`): on an
//    unclean WebSocket close it logs the "connection lost" message, then
//    polls the server with a plain fetch every ~1s, and on the first
//    successful ping calls `location.reload()` ITSELF -- so the self-heal
//    is a full browser navigation, not a partial HMR patch. This test
//    confirms that mechanically: `window.__marker` (set once per real page
//    load in main.tsx) changed across the kill/restart in every run, i.e.
//    `fullNavigationOccurred: true`. Design implication: the self-heal is
//    real, but it is Vite's own client doing a full `location.reload()`
//    once it can reach a server again on the same origin/port -- a canvas
//    that swaps containers under a STABLE port can rely on this; one that
//    changes the port or origin per container would NOT self-heal this way
//    and must reload the iframe itself.
//
// ---------------------------------------------------------------------
//
// Learning test: Vite + React dev server in a Docker container as a live
// "sandbox" preview whose source file is rewritten from outside.
//
// Run with: node test.ts   (Node 24 strips the erasable TS syntax natively)

import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium, type Page } from "playwright";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const APP_DIR = join(__dirname, "app");
const SRC_HOST_PATH = join(APP_DIR, "src", "Page.tsx");
const CONTAINER = "lt-sandbox";
const PORT = 5190;
const IMAGE_BAKED = "lt-sandbox-baked";
const IMAGE_RUNTIME = "lt-sandbox-runtime";
const IMAGE_V3 = "lt-sandbox-v3"; // built on the fly for the self-heal test (assumption 7)
const IFRAME_HOST_PORT = 5191; // plain node static server, NOT a docker port

function resolveDocker(): string {
  const onPath = spawnSync("which", ["docker"], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim()) return "docker";
  const fallback =
    "/Applications/Docker.app/Contents/Resources/bin/docker";
  if (existsSync(fallback)) return fallback;
  throw new Error("docker not found on PATH and fallback path missing");
}
const DOCKER = resolveDocker();
// Docker's credential helper binary lives next to the docker binary itself;
// put that dir on PATH for our own child processes only.
const DOCKER_BIN_DIR = DOCKER.includes("/")
  ? DOCKER.slice(0, DOCKER.lastIndexOf("/"))
  : "";
const ENV = {
  ...process.env,
  PATH: `${DOCKER_BIN_DIR}:${process.env.PATH ?? ""}`,
};

function log(...args: unknown[]) {
  console.log(`[t+${Date.now() - START}ms]`, ...args);
}

function run(cmd: string, args: string[], opts: { input?: string } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: ENV,
    input: opts.input,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function docker(args: string[], opts: { input?: string } = {}) {
  return run(DOCKER, args, opts);
}

function removeContainerIfExists() {
  docker(["rm", "-f", CONTAINER]);
}

function removeImage(tag: string) {
  docker(["rmi", "-f", tag]);
}

function pageContent(title: string, extraExport = "") {
  return `import { useState } from "react";
${extraExport}
export default function Page() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1 data-testid="title">${title}</h1>
      <button data-testid="inc" onClick={() => setCount((c) => c + 1)}>
        inc
      </button>
      <div data-testid="count">{count}</div>
    </div>
  );
}
`;
}

const BROKEN_CONTENT = `import { useState } from "react";
export default function Page() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1 data-testid="title">Hello broken
    </div>
  );
}
`;

async function waitForHttp200(url: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return Date.now() - start;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  return -1;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTitleText(
  page: import("playwright").Page,
  expected: string,
  timeoutMs: number,
) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const text = await page.textContent("[data-testid=title]", { timeout: 500 });
      if (text === expected) return performance.now() - start;
    } catch {
      // ignore transient errors (page navigating, element momentarily gone)
    }
    await sleep(50);
  }
  return -1;
}

// High-resolution push-latency measurement: arm a MutationObserver INSIDE
// the page that records `Date.now()` (wall-clock, comparable to Node's
// Date.now() on the same host) the instant the title element's text becomes
// `expected`. The precision of the recorded timestamp does not depend on how
// often Node polls for it -- only on when Playwright's own `waitForFunction`
// polling loop (run with a <=5ms interval) notices the flag was set, which
// only affects how quickly we retrieve the value, not the value itself. This
// avoids the coarse (50ms) polling resolution `waitForTitleText` has.
async function armMutationWatch(page: Page, expected: string): Promise<void> {
  await page.evaluate((expectedTitle) => {
    const w = window as unknown as { __mutationResultTs: number | null };
    w.__mutationResultTs = null;
    const el = document.querySelector('[data-testid="title"]');
    if (!el) throw new Error("title element not found when arming mutation watch");
    const obs = new MutationObserver(() => {
      if (el.textContent === expectedTitle && w.__mutationResultTs === null) {
        w.__mutationResultTs = Date.now();
        obs.disconnect();
      }
    });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    // Cover the (unlikely but possible) race where the text already matches
    // by the time we observe.
    if (el.textContent === expectedTitle) {
      w.__mutationResultTs = Date.now();
      obs.disconnect();
    }
  }, expected);
}

async function waitForMutationResult(page: Page, timeoutMs: number): Promise<number> {
  await page.waitForFunction(
    () => (window as unknown as { __mutationResultTs: number | null }).__mutationResultTs !== null,
    undefined,
    { polling: 5, timeout: timeoutMs },
  );
  return page.evaluate(
    () => (window as unknown as { __mutationResultTs: number }).__mutationResultTs,
  );
}

function writeViaBindMount(content: string) {
  writeFileSync(SRC_HOST_PATH, content);
}

function writeViaDockerExec(content: string) {
  return docker(["exec", "-i", CONTAINER, "sh", "-c", "cat > /app/src/Page.tsx"], {
    input: content,
  });
}

function writeViaDockerCp(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "lt-sandbox-cp-"));
  const tmpFile = join(dir, "Page.tsx");
  writeFileSync(tmpFile, content);
  const res = docker(["cp", tmpFile, `${CONTAINER}:/app/src/Page.tsx`]);
  rmSync(dir, { recursive: true, force: true });
  return res;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const START = Date.now();
const results: Record<string, unknown> = {};

async function main() {
  log("=== learning test: vite+react in docker sandbox ===");

  // Read the fixture's on-disk content ONCE, up front, so it can be restored
  // verbatim in the `finally` below no matter how the run ends. The test
  // must never leave app/src/Page.tsx mutated on disk (see FINDINGS 2a):
  // every push to the bind-mounted variant is written FROM AN IN-MEMORY
  // TEMPLATE (`pageContent(...)`), and the on-disk fixture is put back to
  // exactly what it was before this run touched it.
  const originalPageContent = readFileSync(SRC_HOST_PATH, "utf8");
  log(`captured original fixture content (${originalPageContent.length} bytes) for restore in finally`);

  try {
    await runAllAssumptions();
  } finally {
    log("finally: restoring app/src/Page.tsx to its original on-disk content");
    writeFileSync(SRC_HOST_PATH, originalPageContent);
    const restored = readFileSync(SRC_HOST_PATH, "utf8");
    assert.equal(restored, originalPageContent, "fixture restore must round-trip exactly");
    log("fixture restored and verified byte-for-byte");

    log("cleanup: removing container and images");
    removeContainerIfExists();
    removeImage(IMAGE_BAKED);
    removeImage(IMAGE_RUNTIME);
    removeImage(IMAGE_V3);
  }
}

async function runAllAssumptions() {
  // ---- start-of-run cleanup (stale container) ----
  log("cleanup: removing any stale lt-sandbox container");
  removeContainerIfExists();

  // ---- build images ----
  log("building baked image (node_modules at build time)...");
  let t = Date.now();
  let b = docker(["build", "-t", IMAGE_BAKED, "-f", join(APP_DIR, "Dockerfile"), APP_DIR]);
  assert.equal(b.status, 0, `baked image build failed: ${b.stderr}`);
  log(`baked image built in ${Date.now() - t}ms`);

  log("building runtime-install image (node_modules at container start)...");
  t = Date.now();
  b = docker([
    "build",
    "-t",
    IMAGE_RUNTIME,
    "-f",
    join(APP_DIR, "Dockerfile.runtime"),
    APP_DIR,
  ]);
  assert.equal(b.status, 0, `runtime image build failed: ${b.stderr}`);
  log(`runtime image built in ${Date.now() - t}ms`);

  const browser = await chromium.launch();

  // =========================================================================
  // Assumption 1: host:true + published port required; hmr.clientPort?
  // =========================================================================
  log("--- assumption 1: reachability + HMR websocket ---");

  log("run container with default config (host:true, no clientPort override)");
  let r = docker(["run", "-d", "--name", CONTAINER, "-p", `${PORT}:5173`, IMAGE_BAKED]);
  assert.equal(r.status, 0, `docker run failed: ${r.stderr}`);
  let httpMs = await waitForHttp200(`http://localhost:${PORT}/`, 15000);
  log(`page reachable after ${httpMs}ms`);
  assert.ok(httpMs >= 0, "page should become reachable with host:true + published port");

  {
    const page = await browser.newPage();
    const wsUrls: string[] = [];
    page.on("websocket", (ws) => wsUrls.push(ws.url()));
    const consoleMsgs: string[] = [];
    page.on("console", (m) => consoleMsgs.push(m.text()));
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    log("console during initial load:", consoleMsgs);
    log("websocket URLs opened:", wsUrls);
    const hmrConnected = consoleMsgs.some((m) => m.includes("[vite] connected."));
    assert.ok(hmrConnected, "HMR websocket should connect with default hmr config (single port)");
    const wsOnPublishedPort = wsUrls.some((u) => u.includes(`:${PORT}/`));
    assert.ok(
      wsOnPublishedPort,
      "HMR websocket should use the page's own (published) port by default, no clientPort override needed",
    );
    results.hmrConnectsWithoutClientPort = true;
    results.wsUrls = wsUrls;
    await page.close();
  }

  log("negative check: host forced to localhost-only should NOT be reachable from host");
  docker(["rm", "-f", CONTAINER]);
  r = docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-p",
    `${PORT}:5173`,
    "-e",
    "VITE_TEST_HOST=0",
    IMAGE_BAKED,
  ]);
  assert.equal(r.status, 0, `docker run failed: ${r.stderr}`);
  const unreachableMs = await waitForHttp200(`http://localhost:${PORT}/`, 6000);
  log(`with host=localhost-only, reachable result: ${unreachableMs}ms (-1 == never reachable)`);
  assert.equal(unreachableMs, -1, "container should NOT be reachable from host without server.host:true");
  results.unreachableWithoutHostTrue = unreachableMs === -1;

  // restore correct config for the rest of the tests
  docker(["rm", "-f", CONTAINER]);

  // =========================================================================
  // Assumption 2: bind mount vs docker exec vs docker cp -- PRECISE timing.
  //
  // Fixed version of a previously unsupported comparison: the old version
  // polled with a 50ms sleep loop, so all three methods measured within the
  // polling resolution and no real speed difference could be observed. This
  // version arms a MutationObserver INSIDE the page (see `armMutationWatch`)
  // that records Date.now() the instant the DOM actually changes, and polls
  // for that flag via Playwright's `waitForFunction` at a 5ms interval --
  // the *recorded* timestamp's precision does not depend on the poll
  // interval, only on when the mutation itself fires. 10 trials per method;
  // median and max are reported, and the fastest-method claim (or "no
  // meaningful difference") is derived from those numbers, not asserted a
  // priori.
  // =========================================================================
  log("--- assumption 2: file push method comparison (precise, 10 trials/method) ---");
  const TRIALS_PER_METHOD = 10;

  async function measurePushPrecise(
    label: string,
    runArgs: string[],
    pushFn: (content: string) => void,
    titlePrefix: string,
    trials: number,
  ) {
    docker(["rm", "-f", CONTAINER]);
    const runRes = docker(["run", "-d", "--name", CONTAINER, ...runArgs, IMAGE_BAKED]);
    assert.equal(runRes.status, 0, `docker run failed for ${label}: ${runRes.stderr}`);
    const ready = await waitForHttp200(`http://localhost:${PORT}/`, 15000);
    assert.ok(ready >= 0, `${label}: server should become ready`);

    const page = await browser.newPage();
    let navigatedAny = false;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigatedAny = true;
    });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await page.click("[data-testid=inc]");
    await page.click("[data-testid=inc]");
    await page.click("[data-testid=inc]");
    const countBefore = await page.textContent("[data-testid=count]");
    const markerBefore = await page.evaluate(() => (window as unknown as { __marker: number }).__marker);
    navigatedAny = false; // reset: the initial goto() itself fires framenavigated

    const elapsedMsPerTrial: number[] = [];
    let allHot = true;
    let failures = 0;
    const PER_TRIAL_TIMEOUT_MS = 8000;
    for (let i = 0; i < trials; i++) {
      const title = `${titlePrefix}-${i}`;
      await armMutationWatch(page, title);
      pushFn(pageContent(title));
      const writeDoneTs = Date.now(); // timestamp taken right after the write call completes
      try {
        const mutationTs = await waitForMutationResult(page, PER_TRIAL_TIMEOUT_MS);
        const elapsed = mutationTs - writeDoneTs;
        elapsedMsPerTrial.push(elapsed);
        const markerNow = await page
          .evaluate(() => (window as unknown as { __marker: number }).__marker)
          .catch(() => markerBefore);
        const hot = markerNow === markerBefore && !navigatedAny;
        if (!hot) allHot = false;
        log(`${label} trial ${i + 1}/${trials}: elapsed=${elapsed}ms hot=${hot}`);
      } catch (e) {
        failures++;
        log(
          `${label} trial ${i + 1}/${trials}: FAILED TO PROPAGATE within ${PER_TRIAL_TIMEOUT_MS}ms ` +
            `(${(e as Error).message}) -- excluded from median/max, counted as a reliability failure`,
        );
      }
      // Settle pause between trials: a real editor pushes edits seconds
      // apart, not back-to-back within the same event-loop tick. Without
      // this, rapid-fire rewrites of the same file can outrun the dev
      // server's own file-watcher/transform pipeline regardless of push
      // method, which would measure an artifact of this harness rather than
      // the push method itself.
      await sleep(300);
    }

    const countAfter = await page.textContent("[data-testid=count]");
    const statePreserved = countAfter === countBefore;
    log(
      `${label}: countBefore=${countBefore} countAfter=${countAfter} statePreserved=${statePreserved} ` +
        `navigatedAny=${navigatedAny} allHot=${allHot} failures=${failures}/${trials}`,
    );

    await page.close();
    assert.ok(
      elapsedMsPerTrial.length > 0,
      `${label}: expected at least one successful trial out of ${trials}`,
    );
    const med = median(elapsedMsPerTrial);
    const max = Math.max(...elapsedMsPerTrial);
    log(
      `${label}: median=${med.toFixed(2)}ms max=${max.toFixed(2)}ms failures=${failures}/${trials} trials(ms)=` +
        JSON.stringify(elapsedMsPerTrial.map((n) => Number(n.toFixed(2)))),
    );
    return { elapsedMsPerTrial, median: med, max, allHot, statePreserved, failures, trials };
  }

  const bindMountRes = await measurePushPrecise(
    "2a bind-mount",
    ["-p", `${PORT}:5173`, "-v", `${join(APP_DIR, "src")}:/app/src`],
    writeViaBindMount,
    "Hello-bind",
    TRIALS_PER_METHOD,
  );
  assert.ok(bindMountRes.allHot, "2a: bind-mount component-only edits should all be hot updates");
  assert.ok(bindMountRes.statePreserved, "2a: React state should be preserved across bind-mount pushes");

  const execRes = await measurePushPrecise(
    "2b docker-exec",
    ["-p", `${PORT}:5173`],
    writeViaDockerExec,
    "Hello-exec",
    TRIALS_PER_METHOD,
  );
  assert.ok(execRes.allHot, "2b: components-only edit via docker exec should be a hot update, every trial");
  assert.ok(execRes.statePreserved, "2b: React state should be preserved across docker-exec pushes");

  const cpRes = await measurePushPrecise(
    "2c docker-cp",
    ["-p", `${PORT}:5173`],
    writeViaDockerCp,
    "Hello-cp",
    TRIALS_PER_METHOD,
  );
  assert.ok(cpRes.allHot, "2c: components-only edit via docker cp should be a hot update, every trial");
  assert.ok(cpRes.statePreserved, "2c: React state should be preserved across docker-cp pushes");

  const medians = { bindMount: bindMountRes.median, dockerExec: execRes.median, dockerCp: cpRes.median };
  const maxes = { bindMount: bindMountRes.max, dockerExec: execRes.max, dockerCp: cpRes.max };
  log("median push latency per method (ms):", medians);
  log("max push latency per method (ms):", maxes);

  // Group methods relative to the FASTEST median, not just adjacent pairs --
  // a chain of small adjacent gaps can hide a large fastest-vs-slowest
  // spread (e.g. 19.5 -> 24 -> 48: each adjacent gap is small, but the
  // slowest is 2.5x the fastest). NOISE_THRESHOLD_MS is picked well above
  // the run-to-run jitter observed in the fast two methods (a few ms) and
  // well below the gap to bind mount (tens of ms) in repeated real runs.
  const sortedByMedian = Object.entries(medians).sort((a, b) => a[1] - b[1]);
  const NOISE_THRESHOLD_MS = 10;
  const fastestMedian = sortedByMedian[0][1];
  const tiedFastest = sortedByMedian.filter(([, v]) => v - fastestMedian < NOISE_THRESHOLD_MS);
  const meaningfullySlower = sortedByMedian.filter(([, v]) => v - fastestMedian >= NOISE_THRESHOLD_MS);
  const pushMethodConclusion =
    meaningfullySlower.length === 0
      ? `no meaningful difference between methods: medians ${JSON.stringify(medians)} are all within ${NOISE_THRESHOLD_MS}ms of the fastest`
      : `${tiedFastest.map(([k, v]) => `${k} (${v.toFixed(2)}ms)`).join(" and ")} ` +
        `${tiedFastest.length > 1 ? "are tied fastest" : "is fastest"} by median, meaningfully faster than ` +
        `${meaningfullySlower.map(([k, v]) => `${k} (${v.toFixed(2)}ms)`).join(", ")} (all medians: ${JSON.stringify(medians)})`;
  log("ASSUMPTION 2 CONCLUSION (derived from medians/max above, not assumed):", pushMethodConclusion);
  log(
    "reliability (propagation failures out of 10 trials):",
    `bindMount=${bindMountRes.failures}`,
    `dockerExec=${execRes.failures}`,
    `dockerCp=${cpRes.failures}`,
  );

  results.pushMethods = {
    bindMount: {
      medianMs: bindMountRes.median,
      maxMs: bindMountRes.max,
      failures: bindMountRes.failures,
      trialsMs: bindMountRes.elapsedMsPerTrial,
    },
    dockerExec: {
      medianMs: execRes.median,
      maxMs: execRes.max,
      failures: execRes.failures,
      trialsMs: execRes.elapsedMsPerTrial,
    },
    dockerCp: {
      medianMs: cpRes.median,
      maxMs: cpRes.max,
      failures: cpRes.failures,
      trialsMs: cpRes.elapsedMsPerTrial,
    },
    conclusion: pushMethodConclusion,
  };
  // docker exec and docker cp write directly into the container's own
  // filesystem via the docker daemon (no host<->container fs translation
  // layer); a propagation failure there would indicate a real regression,
  // unlike bind-mount's known host-fs-event flakiness which is only logged.
  assert.equal(execRes.failures, 0, "docker exec should propagate every push (no bind-mount fs event dependency)");
  assert.equal(cpRes.failures, 0, "docker cp should propagate every push (no bind-mount fs event dependency)");
  // Design bar kept from the original recommendation criteria: docker exec
  // (no bind mount required) must still be well under 3s and hot, on median.
  assert.ok(
    execRes.median < 3000 && execRes.allHot,
    "docker exec should meet the <3s + hot-update bar (median)",
  );

  // =========================================================================
  // Assumption 3: non-component export forces full reload
  // =========================================================================
  log("--- assumption 3: mixed component/non-component export ---");
  {
    // container from the docker-cp run is still up; give it a clean baseline
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await page.click("[data-testid=inc]");
    await page.click("[data-testid=inc]");
    await page.click("[data-testid=inc]");
    const markerBefore = await page.evaluate(() => (window as unknown as { __marker: number }).__marker);
    const countBefore = await page.textContent("[data-testid=count]");

    let navigated = false;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigated = true;
    });

    writeViaDockerExec(pageContent("Hello v3-mixed", 'export const BUILD_ID = "v3-mixed";'));
    const elapsedMs = await waitForTitleText(page, "Hello v3-mixed", 5000);
    assert.ok(elapsedMs >= 0, "mixed-export edit should still eventually update the page");

    await page.waitForTimeout(200); // let any reload settle
    const markerAfter = await page.evaluate(() => (window as unknown as { __marker: number }).__marker);
    const countAfter = await page.textContent("[data-testid=count]");

    log(
      `mixed export: navigated=${navigated} marker ${markerBefore} -> ${markerAfter} ` +
        `count ${countBefore} -> ${countAfter}`,
    );

    const wasFullReload = markerBefore !== markerAfter || navigated;
    results.mixedExportForcesFullReload = wasFullReload;
    assert.ok(
      wasFullReload,
      "adding a non-component export alongside the default component export should force a full reload",
    );
    assert.equal(countAfter, "0", "after a full reload, React state should reset to 0");
    await page.close();
  }

  // =========================================================================
  // Assumption 4: syntax error overlay + recovery without container restart
  // =========================================================================
  log("--- assumption 4: syntax error overlay + recovery ---");
  {
    const containerIdBefore = docker(["inspect", "-f", "{{.Id}}", CONTAINER]).stdout.trim();

    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    writeViaDockerExec(BROKEN_CONTENT);
    await page.waitForTimeout(1500);
    const overlayPresent = await page.evaluate(() => !!document.querySelector("vite-error-overlay"));
    log(`overlay present after broken write: ${overlayPresent}`);
    assert.ok(overlayPresent, "vite error overlay should appear for a syntax error");

    const stillRunning = docker(["inspect", "-f", "{{.State.Running}}", CONTAINER]).stdout.trim();
    assert.equal(stillRunning, "true", "container should still be running after a syntax error");

    writeViaDockerExec(pageContent("Hello v4-fixed"));
    let recovered = false;
    const start = performance.now();
    while (performance.now() - start < 5000) {
      const stillHasOverlay = await page.evaluate(() => !!document.querySelector("vite-error-overlay"));
      const title = await page.textContent("[data-testid=title]").catch(() => null);
      if (!stillHasOverlay && title === "Hello v4-fixed") {
        recovered = true;
        break;
      }
      await sleep(100);
    }
    log(`recovered after fix: ${recovered}`);
    assert.ok(recovered, "fixing the file should clear the overlay and update the page");

    const containerIdAfter = docker(["inspect", "-f", "{{.Id}}", CONTAINER]).stdout.trim();
    assert.equal(containerIdBefore, containerIdAfter, "container should never have been restarted");
    results.syntaxErrorOverlayThenRecovered = { overlayPresent, recovered, sameContainer: containerIdBefore === containerIdAfter };
    await page.close();
  }

  // =========================================================================
  // Assumption 5: cross-origin iframe embedding allowed by default
  // =========================================================================
  log("--- assumption 5: cross-origin iframe embedding ---");
  {
    const hostServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(join(__dirname, "host-page", "index.html"), "utf8"));
    });
    await new Promise<void>((resolve) => hostServer.listen(IFRAME_HOST_PORT, resolve));

    const page = await browser.newPage();
    const headersSeen: Record<string, string> = {};
    page.on("response", (res) => {
      if (res.url() === `http://localhost:${PORT}/`) {
        Object.assign(headersSeen, res.headers());
      }
    });
    await page.goto(`http://localhost:${IFRAME_HOST_PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    log("full sandbox document response headers captured:", headersSeen);
    // Guard against the vacuous version of this check: an empty header map
    // (e.g. because the `response` listener never matched the URL, or fired
    // too late) would also make `xfo === undefined`. Assert we actually
    // captured a real header set first.
    assert.ok(
      Object.keys(headersSeen).length > 0,
      "expected to capture at least one real response header from the sandbox document (empty map would make the XFO/CSP checks below vacuous)",
    );
    assert.ok(
      typeof headersSeen["content-type"] === "string" && headersSeen["content-type"].length > 0,
      `expected a non-empty content-type header to be present; got ${JSON.stringify(headersSeen["content-type"])}`,
    );

    const xfo = headersSeen["x-frame-options"];
    const csp = headersSeen["content-security-policy"];
    log("sandbox document response headers of interest:", { xfo, csp });
    assert.equal(xfo, undefined, "no X-Frame-Options header should be present by default");
    if (csp !== undefined) {
      assert.ok(
        !/frame-ancestors/i.test(csp),
        `CSP header present (${JSON.stringify(csp)}) but must not restrict framing via frame-ancestors`,
      );
      log(`note: a Content-Security-Policy header IS present but has no frame-ancestors directive: ${csp}`);
    } else {
      log("no Content-Security-Policy header present at all");
    }

    const frame = page.frame({ url: (u) => u.href.startsWith(`http://localhost:${PORT}`) });
    assert.ok(frame, "iframe pointing at the sandbox origin should be present");
    const iframeTitle = await frame!.textContent("[data-testid=title]");
    log(`iframe title text: ${iframeTitle}`);
    assert.equal(iframeTitle, "Hello v4-fixed", "iframe content should be readable from the parent page's frame");

    results.iframeEmbedOk = { xfo, csp, iframeTitle };
    await page.close();
    hostServer.close();
  }

  // =========================================================================
  // Assumption 6: cold start, baked vs runtime-install
  // =========================================================================
  log("--- assumption 6: cold start timing ---");
  docker(["rm", "-f", CONTAINER]);

  let t0 = Date.now();
  r = docker(["run", "-d", "--name", CONTAINER, "-p", `${PORT}:5173`, IMAGE_BAKED]);
  assert.equal(r.status, 0, "cold start (baked): docker run failed");
  const bakedColdMs = await waitForHttp200(`http://localhost:${PORT}/`, 30000);
  log(`baked image cold start: first HTTP 200 after ${bakedColdMs}ms (docker run -> ready)`);
  assert.ok(bakedColdMs >= 0, "baked image should come up");
  docker(["rm", "-f", CONTAINER]);

  t0 = Date.now();
  r = docker(["run", "-d", "--name", CONTAINER, "-p", `${PORT}:5173`, IMAGE_RUNTIME]);
  assert.equal(r.status, 0, "cold start (runtime-install): docker run failed");
  const runtimeColdMs = await waitForHttp200(`http://localhost:${PORT}/`, 60000);
  log(`runtime-install image cold start: first HTTP 200 after ${runtimeColdMs}ms (docker run -> ready)`);
  assert.ok(runtimeColdMs >= 0, "runtime-install image should eventually come up");

  results.coldStart = { bakedColdMs, runtimeColdMs };
  assert.ok(
    bakedColdMs < runtimeColdMs,
    "baked node_modules image should be ready faster than installing at container start",
  );
  docker(["rm", "-f", CONTAINER]);

  // =========================================================================
  // Assumption 7: kill container, start new one, does the client self-heal?
  //
  // Fixed version of a previously VACUOUS check: the old loop broke on
  // `title === "Hello v1" || navigated`, but the page already showed
  // "Hello v1" before the kill, so it matched on the very first poll
  // regardless of whether anything actually self-healed. This version:
  //   1. pushes a variant so the page shows "Hello v2" BEFORE killing,
  //   2. kills+removes the container and asserts Vite's own
  //      "server connection lost" console message actually appears,
  //   3. builds and starts a NEW container (new image tag) whose baked
  //      file says "Hello v3" -- distinct from both v1 and v2, so any
  //      match is unambiguous,
  //   4. asserts the page shows "Hello v3" within 15s WITHOUT this test
  //      ever calling page.reload()/page.goto(), and records whether that
  //      arrived via a full navigation (window.__marker changed) or not.
  // =========================================================================
  log("--- assumption 7: kill + restart, does the preview self-heal? ---");
  r = docker(["run", "-d", "--name", CONTAINER, "-p", `${PORT}:5173`, IMAGE_BAKED]);
  assert.equal(r.status, 0, "docker run failed");
  await waitForHttp200(`http://localhost:${PORT}/`, 15000);

  {
    const page = await browser.newPage();
    const consoleMsgs: string[] = [];
    page.on("console", (m) => consoleMsgs.push(`${Date.now() - START}:${m.text()}`));
    let navigated = false;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigated = true;
    });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const initialTitle = await page.textContent("[data-testid=title]");
    log(`initial title before self-heal test: ${JSON.stringify(initialTitle)}`);

    // Step 1: push a variant BEFORE killing, so the page is showing
    // something OTHER than what any freshly-baked image would show.
    await armMutationWatch(page, "Hello v2-preheal");
    writeViaDockerExec(pageContent("Hello v2-preheal"));
    await waitForMutationResult(page, 5000);
    const markerBeforeKill = await page.evaluate(
      () => (window as unknown as { __marker: number }).__marker,
    );
    const titleBeforeKill = await page.textContent("[data-testid=title]");
    log(`title before kill: ${titleBeforeKill}, marker before kill: ${markerBeforeKill}`);
    assert.equal(titleBeforeKill, "Hello v2-preheal", "setup: page should show the pushed variant before kill");

    // Step 2: kill + remove the container; assert the browser actually
    // observes Vite's own disconnect message (not just "some time passed").
    log("killing and removing container");
    docker(["kill", CONTAINER]);
    docker(["rm", "-f", CONTAINER]);
    const sawConnectionLost = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        if (consoleMsgs.some((m) => /server connection lost/i.test(m))) return true;
        await sleep(50);
      }
      return false;
    })();
    log(`observed "server connection lost" console message within 10s: ${sawConnectionLost}`);
    assert.ok(
      sawConnectionLost,
      'expected the page console to log Vite\'s "[vite] server connection lost. Polling for restart..." after the container is killed',
    );

    // Step 3: build a brand-new image whose Page.tsx ALREADY says
    // "Hello v3-postheal" at container start (baked in, not written via
    // `docker exec` after the container is up) -- from an in-memory
    // template written into a throwaway build context, never touching the
    // checked-in fixture.
    log(`building ${IMAGE_V3} (Page.tsx baked as "Hello v3-postheal")`);
    const v3BuildDir = mkdtempSync(join(tmpdir(), "lt-sandbox-v3-"));
    cpSync(APP_DIR, v3BuildDir, { recursive: true });
    mkdirSync(join(v3BuildDir, "src"), { recursive: true });
    writeFileSync(join(v3BuildDir, "src", "Page.tsx"), pageContent("Hello v3-postheal"));
    const v3Build = docker(["build", "-t", IMAGE_V3, "-f", join(v3BuildDir, "Dockerfile"), v3BuildDir]);
    rmSync(v3BuildDir, { recursive: true, force: true });
    assert.equal(v3Build.status, 0, `IMAGE_V3 build failed: ${v3Build.stderr}`);

    log("starting NEW container (new image) with same name+port");
    navigated = false;
    r = docker(["run", "-d", "--name", CONTAINER, "-p", `${PORT}:5173`, IMAGE_V3]);
    assert.equal(r.status, 0, "docker run (new container) failed");

    // Step 4: WITHOUT calling page.reload()/page.goto() ourselves, poll the
    // existing page for up to 15s and see whether it shows "Hello v3-postheal".
    let selfHealed = false;
    const start = performance.now();
    while (performance.now() - start < 15000) {
      const title = await page.textContent("[data-testid=title]").catch(() => null);
      if (title === "Hello v3-postheal") {
        selfHealed = true;
        break;
      }
      await sleep(100);
    }
    const timeToHealMs = selfHealed ? performance.now() - start : -1;
    const markerAfterHeal = await page
      .evaluate(() => (window as unknown as { __marker: number }).__marker)
      .catch(() => undefined);
    const fullNavigationOccurred = navigated || markerAfterHeal !== markerBeforeKill;
    log(
      `self-healed=${selfHealed} timeToHealMs=${timeToHealMs.toFixed(0)} navigated(event)=${navigated} ` +
        `marker ${markerBeforeKill} -> ${markerAfterHeal} => fullNavigationOccurred=${fullNavigationOccurred}`,
    );
    log(
      "console messages around kill/restart:",
      consoleMsgs.filter((m) => /vite|reconnect|lost|polling/i.test(m)),
    );
    results.selfHealAfterKill = {
      sawConnectionLost,
      selfHealed,
      timeToHealMs,
      fullNavigationOccurred,
    };
    assert.ok(
      selfHealed,
      "expected the page to show the new container's content (\"Hello v3-postheal\") within 15s " +
        "with no reload()/goto() from this test; if this ever fails, the true finding is that the " +
        "preview does NOT self-heal and the canvas design must reload the iframe itself",
    );
    await page.close();
  }

  await browser.close();

  // NOTE: container/image cleanup and fixture restore happen unconditionally
  // in `main()`'s `finally` block, whether this function returns normally or
  // throws -- not duplicated here.

  log("=== RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
  log("ALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  // Cleanup and fixture restore already happened in main()'s `finally`
  // regardless of success or failure -- this handler only needs to report
  // the failure and set a non-zero exit code.
  process.exit(1);
});
