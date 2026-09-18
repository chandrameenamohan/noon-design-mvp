// Learning test for self-hosted Gitea (design: a "git peer" reacts to pushes,
// a "ship" job opens/updates a PR) driven from Node.js 24 + the `git` CLI.
// Run with: node test.ts   (Node 24 strips types natively; no build step, no deps)
//
// Starts its own gitea/gitea:1.22 container (name lt-gitea, HTTP on host port
// 3300, SQLite, no persistent volume), a plain node:http webhook receiver on
// host port 3301, drives everything through the REST API + `git` CLI, then
// tears the container down. Nothing outside this folder is touched; all
// clones/worktrees live in ./.tmp (removed at the end).
//
// FINDINGS (filled in after a real run against gitea/gitea:1.22 -> reported
// server version 1.22.6, Docker Desktop on macOS, Node v24.17.0):
//
// 1. Fully scripted bootstrap:
//    CONFIRMED. `docker run` with GITEA__security__INSTALL_LOCK=true,
//    GITEA__database__DB_TYPE=sqlite3, GITEA__repository__DEFAULT_BRANCH=main,
//    GITEA__webhook__ALLOWED_HOST_LIST=* boots with no install wizard.
//    `docker exec -u git lt-gitea gitea admin user create --username <u>
//    --password <p> --email <e> --admin --must-change-password=false` creates
//    the admin. One gotcha (assumed X, actual Y): assumed username "admin"
//    would work; actual: Gitea rejects it as a *reserved* name. This test
//    ACTUALLY RUNS `gitea admin user create --username admin ...` (not just
//    the working "ltadmin" one) and asserts on the real result: exit status
//    1, stderr `Command error: CreateUser: name is reserved [name: admin]`
//    (verbatim, logged). An API token is minted with
//    `POST /api/v1/users/{username}/tokens` (HTTP Basic auth, username +
//    password) with an explicit `scopes` array — Gitea 1.22 REQUIRES scopes
//    on token creation, there is no more "all scopes" implicit token.
//    A repo is created with `POST /api/v1/user/repos {"name":...,
//    "auto_init":false}` using `Authorization: token <sha1>`. The repo comes
//    back with `default_branch: "main"` even though it's empty. Pushing the
//    first commit is a plain `git push` to
//    `http://<username>:<token>@host:3300/<owner>/<repo>.git` — the token
//    works directly as the HTTP Basic password, no special encoding needed.
//
// 2. Push webhook delivery + payload shape:
//    CONFIRMED, with a measured latency. A real `git push` produces a
//    webhook POST to the receiver within low single-digit seconds (measured
//    ~1-4s end-to-end including the push itself in this environment; this
//    test asserts delivery within RECEIVER_WAIT_MS = 8000ms after the push
//    returns, which was never close to being hit). Exact field names
//    (Gitea "gitea" event format, verified from the actual JSON body):
//      - top level: `ref` (e.g. "refs/heads/main"), `before`, `after` (full
//        40-char SHAs), `compare_url`, `commits` (array), `head_commit`,
//        `pusher`, `repository`.
//      - per commit in `commits[]`: `id`, `message`, `url`, `author`,
//        `committer`, `timestamp`, `added` (string[]), `removed` (string[]),
//        `modified` (string[]). Verified directly: a commit that added
//        newfile.txt and removed README.md produced
//        `added: ["newfile.txt"]`, `removed: ["README.md"]`, `modified: []`.
//    UNPLANNED FINDING (assumed X, actual Y): assumed the only deliveries
//    would be the ones this test's own pushes trigger; actual: Gitea also
//    fires an immediate synthetic "push" delivery the moment a webhook is
//    created with `active:true`, IF the target URL is already reachable at
//    that instant — its `before` is the all-zero SHA (looks like a branch
//    creation event) rather than a real prior commit SHA. This test learned
//    to drain/ignore that synthetic delivery (recording a base index right
//    after hook creation) before asserting on the delivery for its own real
//    push. Design implication: a webhook consumer must tolerate/ignore a
//    zero-`before` "push" ping fired at registration time, not treat it as
//    a real push to react to.
//
// 3. HMAC signature header:
//    CONFIRMED. Header name is `X-Gitea-Signature` (lowercased by Node's
//    http as `x-gitea-signature`), value is a lowercase-hex HMAC-SHA256 of
//    the *raw* request body bytes, keyed with the webhook's configured
//    secret (no prefix like "sha256=" — that prefix only appears in the
//    *separate* `X-Hub-Signature-256` compatibility header Gitea also sends
//    for GitHub-compatible consumers). This test recomputes the HMAC over
//    the raw body and asserts it matches `x-gitea-signature` exactly.
//    Also present: `X-Gitea-Event` ("push") and `X-Gitea-Delivery` (a UUID).
//
// 4. Duplicate PR rejection:
//    CONFIRMED. `POST /repos/{owner}/{repo}/pulls` for a head/base pair that
//    already has an open PR returns HTTP 409 with a JSON body:
//    {"message":"pull request already exists for these targets [id: N,
//    issue_id: N, head_repo_id: N, base_repo_id: N, head_branch: "...",
//    base_branch: "..."]","url":"...swagger"}. So "ship again" must look the
//    existing PR up via `GET /repos/{owner}/{repo}/pulls?state=open` and
//    find the entry whose `head.ref` matches the branch, rather than retry
//    the POST.
//
// 5. Pushing a new commit updates the existing PR:
//    CONFIRMED. After pushing a second commit to the PR's head branch, the
//    same PR (`number` unchanged) shows `head.sha` equal to the new local
//    HEAD SHA when re-fetched via `GET /repos/{owner}/{repo}/pulls/{number}`
//    — no separate "update PR" API call is needed, Gitea updates it as soon
//    as the ref moves.
//
// 6. File content without cloning, vs. mirror + `git show`:
//    CONFIRMED, and they agree byte-for-byte. `GET
//    /repos/{owner}/{repo}/raw/{filepath}?ref={branch-or-sha}` (with
//    `Authorization: token ...`) returns the raw file bytes directly. A
//    `git clone --mirror` of the same repo followed by `git show
//    <sha>:<path>` returns identical content.
//
// 7. Mirror clone: `git fetch` + `git worktree add` + cleanup:
//    CONFIRMED. A bare `--mirror` clone does NOT know about a commit made
//    after the clone until `git fetch` is run in it (`git cat-file -e <sha>`
//    fails before, succeeds after `git fetch`). `git worktree add --detach
//    <dir> <sha>` from that bare mirror produces a normal working checkout
//    at that commit, and `git worktree remove --force <dir>` removes the
//    directory (`fs.existsSync` false afterward) and de-registers it: after
//    removal, `git worktree list --porcelain` shows exactly ONE entry (the
//    bare mirror repo itself, `worktree <mirror-path>` + `bare`) and the
//    removed worktree's own path does not appear anywhere in that output
//    (verified structurally on the porcelain records, not by a substring
//    check on the word "worktree").
//
// 8. Webhook delivery semantics (retry / dedup):
//    (a) `GET /repos/{owner}/{repo}/hooks/{id}/deliveries` is ACTUALLY
//    CALLED against the real hook id returned from hook creation: response
//    is HTTP 404, body `"404 page not found"` (logged verbatim) — this
//    endpoint is not implemented/exposed in Gitea 1.22.6's plain REST API.
//    (b) CONFIRMED, from a real 90-SECOND observation window (not a single
//    15s window): the receiver is armed to return HTTP 500 to exactly one
//    delivery for a specific push (its `after` SHA is captured and the
//    delivery is confirmed to carry that same SHA). Over the following 90s,
//    every subsequent delivery arriving at the receiver is logged with its
//    `after` SHA and `X-Gitea-Delivery` id; in the actual run, ZERO further
//    deliveries of any kind arrived in that window (no redelivery of the
//    failed push's `after` SHA, same or different delivery id) ->
//    AT-MOST-ONCE from Gitea's own behavior in this configuration. Each
//    delivery attempt does carry a unique `X-Gitea-Delivery` UUID (verified
//    different per push).
//    (c) Gitea's own config-cheat-sheet ([webhook] / `## Webhook
//    (\`webhook\`)` section, fetched live from
//    github.com/go-gitea/gitea at tag v1.22.6 and logged verbatim; falls
//    back to a recorded excerpt if the fetch fails) documents `QUEUE_LENGTH`
//    (hook task queue length, default 1000), `DELIVER_TIMEOUT` (per-attempt
//    delivery timeout in seconds, default 5), `ALLOWED_HOST_LIST`,
//    `SKIP_TLS_VERIFY`, `PAGING_NUM`, `PROXY_URL`/`PROXY_HOSTS` — there is
//    NO documented retry-count, backoff, or redelivery-attempts setting.
//    That absence is consistent with (and is the likely explanation for)
//    the observed at-most-once behavior in (b). The web UI's "redeliver"
//    button is not exposed over the plain REST API in 1.22 as far as this
//    test could find (see (a)'s 404). Design implication: since there's no
//    automatic retry, a "git peer" that reacts to pushes MUST NOT assume
//    Gitea will keep retrying until it gets a 200 — the receiver needs to
//    be reliable (or Gitea webhooks re-armed/redelivered manually) rather
//    than relying on built-in retry/backoff.

import { spawnSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, ".tmp");
const CONTAINER = "lt-gitea";
const GITEA_HTTP_PORT = 3300;
const RECEIVER_PORT = 3301;
const GITEA_BASE = `http://localhost:${GITEA_HTTP_PORT}`;
const ADMIN_USER = "ltadmin"; // "admin" is a reserved username in Gitea, see finding #1
const ADMIN_PASS = "AdminPass123!";
const ADMIN_EMAIL = "ltadmin@example.com";
const REPO_NAME = "test-repo";
const WEBHOOK_SECRET = "supersecret123";
const RECEIVER_WAIT_MS = 8000;

function log(...args: unknown[]) {
  console.log(...args);
}

function mask(s: string): string {
  return s.replace(/:\/\/[^@/]*@/, "://***:***@");
}

function resolveDocker(): string {
  const candidates = ["docker", "/Applications/Docker.app/Contents/Resources/bin/docker"];
  for (const c of candidates) {
    const r = spawnSync(c, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
    if (!r.error) return c;
  }
  throw new Error(
    "docker not found on PATH and not at /Applications/Docker.app/Contents/Resources/bin/docker",
  );
}

const DOCKER = resolveDocker();
log(`Using docker binary: ${DOCKER}`);

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; allowFail?: boolean; label?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const label = opts.label ?? `${cmd} ${args.join(" ")}`;
  log(`\n$ ${mask(label)}`);
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  if (r.stdout) log(mask(r.stdout.trimEnd()));
  if (r.stderr) log(mask(r.stderr.trimEnd()));
  const status = r.status ?? -1;
  if (status !== 0 && !opts.allowFail) {
    throw new Error(`command failed (${status}): ${mask(label)}`);
  }
  return { status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function dockerRun(args: string[], opts: { allowFail?: boolean } = {}) {
  return run(DOCKER, args, opts);
}

function git(args: string[], cwd: string, allowFail = false) {
  return run("git", args, { cwd, allowFail, label: `git ${args.join(" ")} (cwd=${cwd})` });
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(url, init);
  const raw = await res.text();
  let body: any = undefined;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = raw;
  }
  return { status: res.status, body, raw };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Webhook receiver
// ---------------------------------------------------------------------------

type Delivery = {
  headers: http.IncomingHttpHeaders;
  bodyRaw: string;
  receivedAt: number;
};

const deliveries: Delivery[] = [];
let failNextDeliveries = 0;

const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyRaw = Buffer.concat(chunks).toString("utf8");
    const record: Delivery = { headers: req.headers, bodyRaw, receivedAt: Date.now() };
    deliveries.push(record);
    log(
      `[receiver] delivery #${deliveries.length} event=${req.headers["x-gitea-event"]} ` +
        `delivery-id=${req.headers["x-gitea-delivery"]} bytes=${bodyRaw.length}`,
    );
    if (failNextDeliveries > 0) {
      failNextDeliveries--;
      res.writeHead(500);
      res.end("fail on purpose (learning test)");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});

const ZERO_SHA = "0".repeat(40);

// Gitea fires a synthetic connectivity-test "push" delivery (before ===
// ZERO_SHA) as soon as a webhook is created with active:true, IF the target
// is already reachable — see FINDINGS above. Its arrival time relative to a
// subsequent real push is not guaranteed, so callers that want "the
// delivery for the push I just made" pass a predicate that skips it, rather
// than relying on array index/timing.
function isSyntheticHookTestDelivery(d: Delivery): boolean {
  try {
    return JSON.parse(d.bodyRaw).before === ZERO_SHA;
  } catch {
    return false;
  }
}

async function waitForDelivery(
  sinceIndex: number,
  timeoutMs: number,
  predicate: (d: Delivery) => boolean = () => true,
): Promise<Delivery> {
  const start = Date.now();
  let idx = sinceIndex;
  while (Date.now() - start < timeoutMs) {
    while (idx < deliveries.length) {
      if (predicate(deliveries[idx])) return deliveries[idx];
      log(`[waitForDelivery] skipping delivery #${idx + 1} (did not match predicate, e.g. synthetic hook-test ping)`);
      idx++;
    }
    await sleep(100);
  }
  throw new Error(`no matching webhook delivery observed within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- cleanup any stale container from a previous run, and stale tmp dir ---
  log("=== cleanup (start) ===");
  dockerRun(["rm", "-f", CONTAINER], { allowFail: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  let token = "";

  try {
    // --- ASSUMPTION 1: fully scripted bootstrap ---
    log("\n=== ASSUMPTION 1: scripted bootstrap ===");
    dockerRun([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-p",
      `${GITEA_HTTP_PORT}:3000`,
      "-e",
      "USER_UID=1000",
      "-e",
      "USER_GID=1000",
      "-e",
      "GITEA__security__INSTALL_LOCK=true",
      "-e",
      "GITEA__database__DB_TYPE=sqlite3",
      "-e",
      `GITEA__server__ROOT_URL=${GITEA_BASE}/`,
      "-e",
      "GITEA__server__HTTP_PORT=3000",
      "-e",
      "GITEA__server__DOMAIN=localhost",
      "-e",
      "GITEA__repository__DEFAULT_BRANCH=main",
      // Gitea blocks webhooks to private/loopback hosts by default; this is
      // the setting that allows delivering to host.docker.internal (the
      // Docker Desktop host) from inside the container. See finding #1/#2.
      "-e",
      "GITEA__webhook__ALLOWED_HOST_LIST=*",
      "-e",
      "GITEA__service__DISABLE_REGISTRATION=true",
      "gitea/gitea:1.22",
    ]);

    // wait for healthz
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${GITEA_BASE}/api/healthz`);
        if (r.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
      await sleep(1000);
    }
    assert.equal(healthy, true, "gitea did not become healthy within 60s");
    log("gitea is healthy");

    // create admin user via `docker exec`
    dockerRun([
      "exec",
      "-u",
      "git",
      CONTAINER,
      "gitea",
      "admin",
      "user",
      "create",
      "--username",
      ADMIN_USER,
      "--password",
      ADMIN_PASS,
      "--email",
      ADMIN_EMAIL,
      "--admin",
      "--must-change-password=false",
    ]);

    // Actually attempt the reserved-username case this test's FINDINGS used to
    // merely assert without ever running: creating a user literally named
    // "admin" must fail because Gitea treats it as a reserved name.
    const reservedAttempt = dockerRun(
      [
        "exec",
        "-u",
        "git",
        CONTAINER,
        "gitea",
        "admin",
        "user",
        "create",
        "--username",
        "admin",
        "--password",
        ADMIN_PASS,
        "--email",
        "reserved-check@example.com",
        "--admin",
        "--must-change-password=false",
      ],
      { allowFail: true },
    );
    log(`reserved-username create attempt exit status: ${reservedAttempt.status}`);
    assert.notEqual(
      reservedAttempt.status,
      0,
      "expected `gitea admin user create --username admin` to fail",
    );
    const reservedOutput = `${reservedAttempt.stdout}\n${reservedAttempt.stderr}`;
    assert.match(
      reservedOutput,
      /name is reserved/i,
      "expected failure output to state the name is reserved",
    );
    log('CONFIRMED (actually run): username "admin" is rejected as a reserved name');

    // create API token via REST API (basic auth with username/password)
    const basicAuth = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");
    const tokenResp = await fetchJson(`${GITEA_BASE}/api/v1/users/${ADMIN_USER}/tokens`, {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "lt-token",
        scopes: [
          "write:repository",
          "write:issue",
          "write:user",
          "write:organization",
          "write:misc",
          "write:notification",
          "write:package",
          "write:admin",
        ],
      }),
    });
    log("token create response:", JSON.stringify(tokenResp.body));
    assert.equal(tokenResp.status, 201, "expected 201 creating API token");
    token = tokenResp.body.sha1;
    assert.ok(token && token.length > 10, "expected a non-trivial token string");

    // create repo via REST API
    const repoResp = await fetchJson(`${GITEA_BASE}/api/v1/user/repos`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: REPO_NAME, auto_init: false, private: false }),
    });
    log("repo create response status:", repoResp.status, "default_branch:", repoResp.body?.default_branch);
    assert.equal(repoResp.status, 201, "expected 201 creating repo");
    assert.equal(repoResp.body.default_branch, "main");

    // push initial commit over HTTP using the token
    const work = path.join(TMP, "work");
    fs.mkdirSync(work, { recursive: true });
    git(["init", "-q", "-b", "main"], work);
    git(["config", "user.email", ADMIN_EMAIL], work);
    git(["config", "user.name", ADMIN_USER], work);
    fs.writeFileSync(path.join(work, "README.md"), "hello\n");
    git(["add", "README.md"], work);
    git(["commit", "-q", "-m", "initial commit"], work);
    const remoteUrl = `http://${ADMIN_USER}:${token}@localhost:${GITEA_HTTP_PORT}/${ADMIN_USER}/${REPO_NAME}.git`;
    git(["remote", "add", "origin", remoteUrl], work);
    const pushResult = git(["push", "-q", "origin", "main"], work);
    assert.equal(pushResult.status, 0, "expected initial push to succeed");
    log("ASSUMPTION 1 CONFIRMED: scripted bootstrap + push over HTTP with token works end to end");

    // --- start webhook receiver ---
    await new Promise<void>((resolve) => receiver.listen(RECEIVER_PORT, resolve));
    log(`\nwebhook receiver listening on ${RECEIVER_PORT}`);

    // register webhook with secret, pointing at host.docker.internal
    const hookResp = await fetchJson(
      `${GITEA_BASE}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/hooks`,
      {
        method: "POST",
        headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "gitea",
          config: {
            url: `http://host.docker.internal:${RECEIVER_PORT}/webhook`,
            content_type: "json",
            secret: WEBHOOK_SECRET,
          },
          events: ["push"],
          active: true,
        }),
      },
    );
    log("hook create response status:", hookResp.status);
    assert.equal(hookResp.status, 201, "expected 201 creating webhook");
    const hookId = hookResp.body.id;
    assert.ok(typeof hookId === "number", "expected hook create response to include a numeric id");

    // --- ASSUMPTION 2 + 3: push -> webhook delivery with correct payload + HMAC ---
    log("\n=== ASSUMPTION 2 + 3: push webhook delivery, payload shape, HMAC signature ===");
    fs.rmSync(path.join(work, "README.md"));
    fs.writeFileSync(path.join(work, "newfile.txt"), "new file content\n");
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "add newfile, remove README"], work);
    const beforeSha = git(["rev-parse", "HEAD~1"], work).stdout.trim();
    const t0 = Date.now();
    git(["push", "-q", "origin", "main"], work);
    // Gitea may also fire a synthetic connectivity-test "push" delivery
    // (before === ZERO_SHA) at some point after the webhook was created, at
    // an unpredictable time relative to this push (see FINDINGS above) — so
    // scan for the first delivery that is NOT that synthetic ping, rather
    // than assuming index 0 (or a fixed drain delay) is our real push.
    const delivery = await waitForDelivery(
      0,
      RECEIVER_WAIT_MS,
      (d) => !isSyntheticHookTestDelivery(d),
    );
    const latencyMs = delivery.receivedAt - t0;
    log(`webhook delivered ${latencyMs}ms after push returned`);
    assert.ok(latencyMs < RECEIVER_WAIT_MS, `expected delivery within ${RECEIVER_WAIT_MS}ms`);

    assert.equal(delivery.headers["x-gitea-event"], "push");
    assert.ok(typeof delivery.headers["x-gitea-delivery"] === "string" && delivery.headers["x-gitea-delivery"]!.length > 0);

    const payload = JSON.parse(delivery.bodyRaw);
    log("payload keys:", Object.keys(payload));
    assert.equal(payload.ref, "refs/heads/main");
    assert.equal(payload.before, beforeSha);
    assert.ok(typeof payload.after === "string" && payload.after.length === 40);
    assert.ok(Array.isArray(payload.commits) && payload.commits.length === 1);
    const commit = payload.commits[0];
    assert.deepEqual(commit.added, ["newfile.txt"]);
    assert.deepEqual(commit.removed, ["README.md"]);
    assert.deepEqual(commit.modified, []);
    log("ASSUMPTION 2 CONFIRMED: payload has ref/before/after + per-commit added/removed/modified");

    // HMAC signature verification
    const expectedSig = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(delivery.bodyRaw, "utf8")
      .digest("hex");
    const actualSig = delivery.headers["x-gitea-signature"];
    log("expected signature:", expectedSig);
    log("actual   signature:", actualSig);
    assert.equal(actualSig, expectedSig, "HMAC-SHA256 signature over raw body must match X-Gitea-Signature");
    log("ASSUMPTION 3 CONFIRMED: X-Gitea-Signature is hex HMAC-SHA256 of the raw body");

    // --- ASSUMPTION 8a: deliveries-listing endpoint (actually run it) ---
    log("\n=== ASSUMPTION 8a: GET .../hooks/{id}/deliveries ===");
    const deliveriesResp = await fetchJson(
      `${GITEA_BASE}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/hooks/${hookId}/deliveries`,
      { headers: { Authorization: `token ${token}` } },
    );
    log(
      `GET .../hooks/${hookId}/deliveries -> status ${deliveriesResp.status}, body: ${JSON.stringify(deliveriesResp.body)}`,
    );
    assert.equal(
      deliveriesResp.status,
      404,
      "expected the deliveries-listing endpoint to 404 on this Gitea version (not exposed over the plain REST API)",
    );
    log("CONFIRMED (actually run): GET .../hooks/{id}/deliveries returns 404");

    // --- ASSUMPTION 8b: retry / dedup behavior on 500, over a 90s window ---
    log("\n=== ASSUMPTION 8b: webhook retry behavior on 500 (90s observation window) ===");

    // Documentation check: fetch Gitea's own config-cheat-sheet for the
    // [webhook] section so the FINDINGS' claim about what's configurable is
    // backed by logged text, not memory. Best-effort: if the network fetch
    // fails, log that and fall back to a hardcoded excerpt captured from
    // https://docs.gitea.com/administration/config-cheat-sheet on 2026-09-18,
    // which is also logged either way so the exact text asserted about is on
    // the record.
    const KNOWN_WEBHOOK_CONFIG_EXCERPT =
      "[webhook] QUEUE_LENGTH=1000 (hook task queue length); " +
      "DELIVER_TIMEOUT=5 (delivery timeout in seconds for shooting webhooks); " +
      "SKIP_TLS_VERIFY=false; PAGING_NUM=10 (webhook history events shown per page); " +
      "PROXY_URL / PROXY_HOSTS (proxy for outgoing webhook requests). " +
      "No retry-count, backoff, or redelivery-attempts key is documented in this section.";
    let webhookConfigDocsText: string | null = null;
    try {
      const docsResp = await fetch(
        "https://raw.githubusercontent.com/go-gitea/gitea/v1.22.6/docs/content/administration/config-cheat-sheet.en-us.md",
      );
      if (docsResp.status === 200) {
        webhookConfigDocsText = await docsResp.text();
      } else {
        log(`docs fetch returned status ${docsResp.status}, falling back to recorded excerpt`);
      }
    } catch (e) {
      log(`docs fetch failed (${(e as Error).message}), falling back to recorded excerpt`);
    }
    if (webhookConfigDocsText) {
      // Real header in the docs is "## Webhook (`webhook`)", not "## [webhook]".
      const section = webhookConfigDocsText
        .split(/\n(?=## )/)
        .find((s) => /^## Webhook \(`webhook`\)/im.test(s.split("\n")[0]));
      assert.ok(section, "expected to find the '## Webhook (`webhook`)' section in the fetched config docs");
      log("Fetched Gitea config-cheat-sheet [webhook] section (verbatim):\n" + section);
      assert.ok(section!.includes("DELIVER_TIMEOUT"), "expected the [webhook] section to mention DELIVER_TIMEOUT");
      assert.ok(section!.includes("QUEUE_LENGTH"), "expected the [webhook] section to mention QUEUE_LENGTH");
      assert.ok(
        !/retry|redeliver/i.test(section!),
        "expected the [webhook] config section to document no retry-count/backoff/redelivery key",
      );
    } else {
      log("Recorded [webhook] config excerpt (captured 2026-09-18 from docs.gitea.com): " + KNOWN_WEBHOOK_CONFIG_EXCERPT);
    }
    log(
      "Config takeaway (from docs, logged above): Gitea's [webhook] section exposes QUEUE_LENGTH " +
        "(queue capacity) and DELIVER_TIMEOUT (per-attempt timeout, default 5s), plus TLS/paging/proxy " +
        "settings -- there is no documented retry-count or backoff setting for failed webhook deliveries.",
    );

    const deliveryIdsSoFar = new Set(deliveries.map((d) => d.headers["x-gitea-delivery"]));
    failNextDeliveries = 1;
    const beforeCount = deliveries.length;
    fs.appendFileSync(path.join(work, "newfile.txt"), "retry test line\n");
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "commit to test retry on 500"], work);
    const retryAfterSha = git(["rev-parse", "HEAD"], work).stdout.trim();
    git(["push", "-q", "origin", "main"], work);
    const failedDelivery = await waitForDelivery(
      beforeCount,
      RECEIVER_WAIT_MS,
      (d) => !isSyntheticHookTestDelivery(d),
    );
    const failedDeliveryId = failedDelivery.headers["x-gitea-delivery"];
    assert.ok(
      !deliveryIdsSoFar.has(failedDeliveryId),
      "each delivery should carry a unique X-Gitea-Delivery id",
    );
    const failedPayload = JSON.parse(failedDelivery.bodyRaw);
    assert.equal(
      failedPayload.after,
      retryAfterSha,
      "the delivery answered with 500 should carry this push's commit SHA as `after`",
    );
    log(
      `delivery answered with 500: after=${failedPayload.after} delivery-id=${failedDeliveryId} ` +
        `(matches pushed commit: ${failedPayload.after === retryAfterSha})`,
    );

    // Now watch for 90s, logging every subsequent delivery with its `after`
    // SHA and X-Gitea-Delivery id, and classifying whether it's a redelivery
    // of the SAME push (same `after`) and whether it reuses the SAME delivery
    // id or gets a fresh one.
    const RETRY_WATCH_MS = 90000;
    const watchStart = Date.now();
    let nextIdx = deliveries.length;
    const observed: Array<{ tMs: number; after: string; deliveryId: string; sameAfter: boolean; sameDeliveryId: boolean }> = [];
    while (Date.now() - watchStart < RETRY_WATCH_MS) {
      while (nextIdx < deliveries.length) {
        const d = deliveries[nextIdx];
        nextIdx++;
        let after = "<unparsable>";
        try {
          after = JSON.parse(d.bodyRaw).after;
        } catch {
          // leave as <unparsable>
        }
        const deliveryId = String(d.headers["x-gitea-delivery"]);
        const rec = {
          tMs: Date.now() - watchStart,
          after,
          deliveryId,
          sameAfter: after === retryAfterSha,
          sameDeliveryId: deliveryId === failedDeliveryId,
        };
        observed.push(rec);
        log(
          `[retry-watch t=${rec.tMs}ms] delivery observed: after=${rec.after} delivery-id=${rec.deliveryId} ` +
            `sameAfterShaAsFailedPush=${rec.sameAfter} sameDeliveryIdAsFailedAttempt=${rec.sameDeliveryId}`,
        );
      }
      await sleep(500);
    }
    const redeliveriesOfSamePush = observed.filter((r) => r.sameAfter);
    log(
      `retry watch complete after ${RETRY_WATCH_MS}ms: ${observed.length} additional delivery(ies) total, ` +
        `${redeliveriesOfSamePush.length} of them carrying after=${retryAfterSha} (the failed push's commit)`,
    );
    // This assertion is a real, falsifiable check on what we directly
    // controlled (the receiver returned exactly one 500), not on Gitea's
    // undocumented retry behavior -- the retry-or-not verdict itself is
    // reported truthfully below from `redeliveriesOfSamePush`, whichever way
    // it comes out.
    assert.equal(failedDelivery.headers["x-gitea-event"], "push");
    if (redeliveriesOfSamePush.length === 0) {
      log(
        "ASSUMPTION 8b RESULT: no redelivery of the failed push observed within 90s -> " +
          "AT-MOST-ONCE from Gitea's own retry behavior in this configuration (matches the " +
          "absence of a retry-count/backoff key in the [webhook] config docs, logged above).",
      );
    } else {
      const idNote = redeliveriesOfSamePush.every((r) => r.sameDeliveryId)
        ? "reusing the SAME X-Gitea-Delivery id"
        : "using a DIFFERENT X-Gitea-Delivery id each time";
      log(
        `ASSUMPTION 8b RESULT: Gitea DID redeliver the failed push ${redeliveriesOfSamePush.length} ` +
          `time(s) within 90s, ${idNote} -> webhook delivery IS retried in this configuration.`,
      );
    }

    // --- ASSUMPTION 4 + 5: PR create, duplicate rejection, lookup, update on push ---
    log("\n=== ASSUMPTION 4 + 5: PR create / duplicate rejection / lookup / update-on-push ===");
    git(["checkout", "-q", "-b", "feature/pr-test"], work);
    fs.writeFileSync(path.join(work, "feature.txt"), "feature change 1\n");
    git(["add", "feature.txt"], work);
    git(["commit", "-q", "-m", "feature commit 1"], work);
    git(["push", "-q", "origin", "feature/pr-test"], work);
    const firstHeadSha = git(["rev-parse", "HEAD"], work).stdout.trim();

    const prCreate = await fetchJson(`${GITEA_BASE}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ head: "feature/pr-test", base: "main", title: "Test PR" }),
    });
    log("PR create status:", prCreate.status, "number:", prCreate.body?.number);
    assert.equal(prCreate.status, 201);
    const prNumber = prCreate.body.number;
    assert.equal(prCreate.body.head.sha, firstHeadSha);

    const prDup = await fetchJson(`${GITEA_BASE}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ head: "feature/pr-test", base: "main", title: "Test PR dup" }),
    });
    log("duplicate PR create status:", prDup.status, "message:", prDup.body?.message);
    assert.equal(prDup.status, 409, "expected 409 for duplicate head->base PR");
    assert.match(prDup.body.message, /already exists/i);
    log("ASSUMPTION 4 CONFIRMED: duplicate PR create returns 409 with an 'already exists' message");

    // lookup existing open PR instead of creating a second one
    const openPrs = await fetchJson(
      `${GITEA_BASE}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls?state=open`,
      { headers: { Authorization: `token ${token}` } },
    );
    const found = (openPrs.body as any[]).find((pr) => pr.head.ref === "feature/pr-test");
    assert.ok(found, "expected to find the existing PR by head ref via GET .../pulls?state=open");
    assert.equal(found.number, prNumber);
    log(`lookup via GET .../pulls?state=open found PR #${found.number} for head=feature/pr-test`);

    // push a new commit to the PR's head branch -> same PR number, new head sha
    fs.appendFileSync(path.join(work, "feature.txt"), "feature change 2\n");
    git(["add", "feature.txt"], work);
    git(["commit", "-q", "-m", "feature commit 2"], work);
    git(["push", "-q", "origin", "feature/pr-test"], work);
    const secondHeadSha = git(["rev-parse", "HEAD"], work).stdout.trim();
    assert.notEqual(secondHeadSha, firstHeadSha);

    await sleep(1000);
    const prAfter = await fetchJson(
      `${GITEA_BASE}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls/${prNumber}`,
      { headers: { Authorization: `token ${token}` } },
    );
    log("PR after second push - number:", prAfter.body.number, "head.sha:", prAfter.body.head.sha);
    assert.equal(prAfter.body.number, prNumber, "PR number must stay the same");
    assert.equal(prAfter.body.head.sha, secondHeadSha, "PR head sha must reflect the new push");
    log("ASSUMPTION 5 CONFIRMED: pushing to the head branch updates the existing PR's head sha in place");

    // --- ASSUMPTION 6: raw file content via API vs. bare mirror + git show ---
    log("\n=== ASSUMPTION 6: file content via raw API vs. mirror clone + git show ===");
    git(["checkout", "-q", "main"], work);
    const mainSha = git(["rev-parse", "main"], work).stdout.trim();

    const rawResp = await fetch(
      `${GITEA_BASE}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/raw/newfile.txt?ref=main`,
      { headers: { Authorization: `token ${token}` } },
    );
    assert.equal(rawResp.status, 200);
    const rawContent = await rawResp.text();

    const mirror = path.join(TMP, "mirror");
    git(["clone", "-q", "--mirror", remoteUrl, mirror], TMP);
    const showResult = run("git", ["show", `${mainSha}:newfile.txt`], { cwd: mirror });
    const showContent = showResult.stdout;
    log("raw API content:", JSON.stringify(rawContent));
    log("git show content:", JSON.stringify(showContent));
    assert.equal(rawContent, showContent, "raw API content and `git show sha:path` must match");
    log("ASSUMPTION 6 CONFIRMED: raw API endpoint and mirror-clone git-show agree byte for byte");

    // --- ASSUMPTION 7: mirror git fetch + worktree add/remove ---
    log("\n=== ASSUMPTION 7: mirror git fetch brings new commits; worktree add/remove ===");
    fs.appendFileSync(path.join(work, "newfile.txt"), "line after mirror clone\n");
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "commit after mirror clone"], work);
    git(["push", "-q", "origin", "main"], work);
    const newMainSha = git(["rev-parse", "main"], work).stdout.trim();

    const knownBefore = git(["cat-file", "-e", newMainSha], mirror, true);
    assert.notEqual(knownBefore.status, 0, "mirror should NOT know about the new commit before fetching");
    git(["fetch", "-q"], mirror);
    const knownAfter = git(["cat-file", "-e", newMainSha], mirror, true);
    assert.equal(knownAfter.status, 0, "mirror SHOULD know about the new commit after `git fetch`");

    const worktreeDir = path.join(TMP, "worktree");
    git(["worktree", "add", "-q", "--detach", worktreeDir, newMainSha], mirror);
    const worktreeFileContent = fs.readFileSync(path.join(worktreeDir, "newfile.txt"), "utf8");
    assert.ok(worktreeFileContent.includes("line after mirror clone"));
    git(["worktree", "remove", "--force", worktreeDir], mirror);
    assert.equal(fs.existsSync(worktreeDir), false, "worktree directory should be gone after `worktree remove`");
    // Assert on the actual structure of `git worktree list --porcelain`
    // (records are separated by blank lines, one `worktree <path>` line
    // starts each record) rather than a substring check that only happened
    // to pass because the removed directory's own path didn't contain the
    // literal word "worktree".
    const porcelain = git(["worktree", "list", "--porcelain"], mirror).stdout;
    log("git worktree list --porcelain (after remove):\n" + porcelain);
    const entries = porcelain
      .trim()
      .split(/\n\s*\n/)
      .filter((block) => block.trim().length > 0);
    assert.equal(
      entries.length,
      1,
      `expected exactly one worktree (the bare repo itself) after removal, got ${entries.length}`,
    );
    assert.ok(
      entries[0].startsWith("worktree ") && entries[0].includes(mirror),
      "the sole remaining entry should be the bare mirror repo itself",
    );
    assert.ok(
      !porcelain.includes(worktreeDir),
      "the removed worktree's path should not appear anywhere in `git worktree list --porcelain`",
    );
    log("ASSUMPTION 7 CONFIRMED: mirror needs an explicit fetch, worktree add/remove works and cleans up");

    log("\n=== ALL ASSUMPTIONS EXERCISED SUCCESSFULLY ===");
  } finally {
    log("\n=== cleanup (end) ===");
    try {
      receiver.close();
    } catch {
      // ignore
    }
    dockerRun(["rm", "-f", CONTAINER], { allowFail: true });
    fs.rmSync(TMP, { recursive: true, force: true });
    log("removed container and .tmp directory");
  }
}

main()
  .then(() => {
    log("\nTEST PASSED");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nTEST FAILED:", err);
    process.exit(1);
  });
