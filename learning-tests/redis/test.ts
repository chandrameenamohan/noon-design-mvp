// Learning test for `ioredis` (Redis 7 client) and `bullmq` (job queues) on Node.js 24.
// Run with: node test.ts   (Node 24 strips types natively; only erasable TS syntax used)
// Self-contained: at startup this removes any stale `lt-redis` container, starts a
// fresh `redis:7` container on 127.0.0.1:6390 via node:child_process, waits until it
// answers PING, runs all tests, and ALWAYS removes the container afterward (finally
// block, even on failure). Requires `docker` on PATH, or at
// /Applications/Docker.app/Contents/Resources/bin/docker.
//
// Design context: one sync node owns each document's "room" via a Redis lease
// (SET NX PX + Lua CAS renew/release + a fencing token), and long-running work
// runs on BullMQ queues backed by the same Redis.
//
// FINDINGS (filled in after an actual run against redis:7 / ioredis@5.11.1 /
// bullmq@5.81.5 / Node v24.17.0, container on port 6390):
//
// 1. SET NX PX atomic lease acquisition:
//    CONFIRMED. With 20 separate physical ioredis connections racing
//    `SET key value NX PX ttl` on the same key at the same time, exactly one
//    got "OK" and the other 19 got null. Redis's single-threaded command
//    execution makes this atomic regardless of client-side concurrency.
//
// 2. CAS renew/release via Lua vs. naive DEL:
//    CONFIRMED. A Lua script that does `if GET(key) == myValue then
//    PEXPIRE/DEL else return 0` correctly refuses to touch a lease it does
//    not own (imposter extend/release both returned 0, real owner's lease
//    was untouched). Demonstrated the actual bug too: a lease holder (C)
//    that lets its lease expire and then issues a bare `DEL key` (with no
//    ownership check) deleted a *different* client's (D's) freshly acquired
//    lease on the same key. assumed "plain DEL is dangerous", actual:
//    reproduced exactly -- D's live lease was wiped by C's stale release.
//
// 3. Fencing token issued atomically with the lease (INCR in the same Lua
//    script as SET NX):
//    CONFIRMED. Across 5 successive acquisition attempts (each waiting for
//    the previous 150ms lease to expire), every successful acquisition
//    returned a token from the same monotonic counter, and tokens strictly
//    increased across owners (e.g. 1, 2, 3, ...). No lease acquisition ever
//    reused or skipped a value in a way that broke monotonicity.
//
// 4. Zombie lease when the client's event loop is blocked past the TTL:
//    CONFIRMED, and re-verified with much wider slack and Redis-side (not
//    wall-clock) timestamps than an earlier draft of this test allowed for.
//    Owner A acquired a 300ms lease (fencing token 1 from the same Lua
//    acquire script as test 3). The main thread then synchronously blocked
//    its OWN event loop for 2000ms via Atomics.wait on a SharedArrayBuffer
//    (measured: unblocked after ~2001-2002ms). A separate OS process (owner
//    B) polled independently and, on winning the lease, recorded Redis's own
//    `TIME` at the moment of acquisition (fencing token 2); A also recorded
//    Redis's own `TIME` immediately after unblocking. Measured margin between
//    B's Redis-side acquisition and A's Redis-side unblock: ~1695-1698ms
//    across repeated runs -- B won the lease and moved on roughly 1.7 seconds
//    before A even had a chance to notice anything was wrong, ruling out any
//    "B only won after A unblocked" ambiguity. Right after unblocking, A's
//    in-memory "I own it" flag was still `true` (measured/logged) while
//    Redis's `GET lease` already returned `owner-B` (measured/logged) --
//    A is a confirmed zombie. A's own CAS-renew Lua script (the same
//    compare-and-set from test 2) was then run as owner-A and returned `0`
//    (measured/logged): Redis's compare-and-set correctly refuses to extend
//    a lease for a client that no longer holds it. The fencing token B
//    acquired (2) was confirmed strictly greater than A's (1) (measured/
//    logged). Implication: the lease/lock alone is not sufficient for safety
//    under GC pauses, blocked event loops, or network partitions -- the
//    *storage layer* must check the fencing token on every write and reject
//    stale (lower) tokens, not just trust "I hold a lock" (a naive in-memory
//    flag, as demonstrated here, survives being wrong indefinitely on its
//    own).
//
// 5. BullMQ jobId dedup, and what happens on re-add after completion:
//    CONFIRMED (dedup) + assumed X, actual Y (post-completion re-add, twice
//    over). Adding the same jobId twice while the first is still
//    waiting/active/completed *and not removed* is deduped: both calls
//    resolve to the same job id, and Redis keeps the FIRST call's data only.
//    assumed "unclear what happens after completion"; actual: if the
//    completed job was removed (removeOnComplete: true, or manually
//    removed), the jobId key no longer exists in Redis, so BullMQ treats it
//    as brand new and a fresh job with the new data IS created. If the
//    completed job still exists (not removed), re-adding the same jobId
//    does NOT change the persisted job -- Redis silently keeps the OLD data.
//    SECOND gotcha found (not part of the original assumption, but
//    important): the `Job` object *returned by* `queue.add(...)` in the
//    deduped case is misleading -- it locally echoes back whatever data you
//    just passed in, even though nothing was actually written to Redis.
//    Only re-fetching with `queue.getJob(id)` reveals the true persisted
//    data. Code that trusts add()'s return value instead of re-reading will
//    believe a write succeeded when it silently didn't.
//
// 6. Worker crash mid-job -> stalled job recovery:
//    CONFIRMED. Measured ~2000-2030ms to recovery with lockDuration=1000ms
//    and stalledInterval=1000ms (order of magnitude: lockDuration + up to
//    one stalledInterval, since the stalled-checker itself first runs
//    immediately on worker B's startup, then polls every stalledInterval,
//    and only reclaims a lock once lockDuration has actually elapsed).
//    Controlling settings:
//    Worker options `lockDuration` (default 30000ms -- how long a lock is
//    held without renewal before it's eligible to be considered stalled),
//    `stalledInterval` (default 30000ms -- how often each active worker
//    polls for stalled jobs), and `maxStalledCount` (default 1 -- how many
//    times a job may be marked stalled before it's failed instead of
//    retried). A worker normally auto-renews its lock at lockDuration/2;
//    force-closing the worker (simulating a crash) stops that renewal, so
//    the lock silently expires and a live worker's periodic stalled-check
//    reclaims the job.
//
// 7. Separate queues with separate Worker concurrency do not starve each other:
//    CONFIRMED. A long (3000ms) job running alone on queue A did not delay a
//    fast (50ms) job added to queue B -- B's job completed in well under
//    3000ms. Each Queue/Worker pair keeps its own Redis connection(s) and
//    polls/blocks independently, so one queue's backlog has no head-of-line
//    blocking effect on another queue.
//
// 8. BullMQ's ioredis connection requirements:
//    CONFIRMED, and more specific than the assumption. The requirement is
//    NOT on the plain `Queue` connection (which never issues blocking
//    commands and does not touch maxRetriesPerRequest at all) -- it's on
//    `Worker`'s internal dedicated *blocking* connection (used for
//    BZPOPMIN-style fetching). assumed "BullMQ requires maxRetriesPerRequest:
//    null broadly"; actual: if you pass Worker a plain options object,
//    BullMQ silently force-overrides maxRetriesPerRequest to null itself
//    (logging a console.error warning if you'd set something else) -- no
//    throw. If you pass Worker a pre-built `ioredis` *instance* whose
//    maxRetriesPerRequest isn't already null, BullMQ throws synchronously:
//    "BullMQ: Your redis options maxRetriesPerRequest must be null." at
//    `new Worker(...)`. Passing a pre-built instance with
//    maxRetriesPerRequest: null already set works fine. Quirk found along
//    the way: with the default `autorun: true`, the constructor schedules
//    its internal run() loop *before* the field that throw leaves
//    unassigned, so catching the constructor's throw isn't enough on its
//    own -- that already-scheduled run() then blows up separately on the
//    unassigned field. Passing `autorun: false` when probing a connection
//    like this avoids that secondary noise.
//
// 9. FLUSHALL loses queued jobs:
//    CONFIRMED. 5 waiting jobs existed, then FLUSHALL wiped the Redis
//    instance, and getJobCounts()/getJobs() afterward showed 0 jobs across
//    every state. This confirms Redis is not durable job storage on its
//    own -- the design's Postgres jobs table as source-of-truth (with Redis
//    treated as a rebuildable cache/queue-transport) is necessary, not
//    optional.

import Redis from "ioredis";
import { Queue, Worker } from "bullmq";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REDIS_HOST = "127.0.0.1";
const REDIS_PORT = 6390;
const CONNECTION = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null as null };
const CONTAINER_NAME = "lt-redis";
const REDIS_IMAGE = "redis:7";

function log(...args: unknown[]) {
  console.log(...args);
}

// ---------------------------------------------------------------------------
// Self-contained lifecycle: resolve a docker binary, remove any stale
// container from a previous run, start a fresh one, wait until it actually
// answers PING, and (from main()) always remove it in a finally block.
// ---------------------------------------------------------------------------
function resolveDockerBin(): string {
  const candidates = ["docker", "/Applications/Docker.app/Contents/Resources/bin/docker"];
  for (const bin of candidates) {
    const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (!res.error && res.status === 0) return bin;
  }
  throw new Error(
    "docker binary not found on PATH or at /Applications/Docker.app/Contents/Resources/bin/docker",
  );
}

const DOCKER_BIN = resolveDockerBin();

function dockerRun(args: string[]) {
  return spawnSync(DOCKER_BIN, args, { encoding: "utf8" });
}

function removeStaleContainer() {
  const res = dockerRun(["rm", "-f", CONTAINER_NAME]);
  log(`removed any stale "${CONTAINER_NAME}" container (docker rm -f exit code ${res.status}, stdout: ${res.stdout?.trim() || "(none)"})`);
}

async function waitForRedisReady(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const probe = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true, retryStrategy: () => null });
    try {
      await probe.connect();
      await probe.ping();
      await probe.quit();
      return;
    } catch (err) {
      lastErr = err;
      probe.disconnect();
      await delay(200);
    }
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for redis to answer PING on ${REDIS_HOST}:${REDIS_PORT}: ${String(lastErr)}`);
}

async function startRedisContainer() {
  removeStaleContainer();
  log(`starting fresh ${REDIS_IMAGE} container "${CONTAINER_NAME}" on port ${REDIS_PORT} via ${DOCKER_BIN}...`);
  const run = dockerRun(["run", "-d", "--rm", "--name", CONTAINER_NAME, "-p", `${REDIS_PORT}:6379`, REDIS_IMAGE]);
  if (run.status !== 0) {
    throw new Error(`docker run failed (status ${run.status}): ${run.stderr}`);
  }
  log("container id:", run.stdout.trim());
  await waitForRedisReady(60_000);
  log("redis container is answering PING");
}

function stopRedisContainer() {
  log(`removing container "${CONTAINER_NAME}"...`);
  const res = dockerRun(["rm", "-f", CONTAINER_NAME]);
  log(`docker rm -f "${CONTAINER_NAME}" exit code:`, res.status);
}

// ---------------------------------------------------------------------------
// TEST 1: SET NX PX acquires a lease atomically -- of N concurrent attempts
// exactly one wins.
// ---------------------------------------------------------------------------
async function test1_atomicLease() {
  log("\n=== TEST 1: SET NX PX atomic lease, N concurrent attempts ===");
  const key = "lease:doc1";
  const N = 20;
  const clients = Array.from({ length: N }, () => new Redis({ host: REDIS_HOST, port: REDIS_PORT }));
  await Promise.all(clients.map((c) => c.ping()));
  await clients[0].del(key);

  const results = await Promise.all(clients.map((c, i) => c.set(key, `owner-${i}`, "PX", 2000, "NX")));
  log("results from", N, "concurrent SET NX attempts:", results);
  const winners = results.filter((r) => r === "OK");
  log("winners count:", winners.length);
  assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}`);

  await Promise.all(clients.map((c) => c.quit()));
}

// ---------------------------------------------------------------------------
// TEST 2: CAS renew/release via Lua ("extend/delete only if I still own it"),
// and the bug when release is a plain DEL.
// ---------------------------------------------------------------------------
async function test2_casReleaseRenew() {
  log("\n=== TEST 2: CAS renew/release via Lua vs. naive DEL bug ===");
  const client = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  const key = "lease:doc2";
  await client.del(key);

  const extendScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;
  const releaseScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  const okA = await client.set(key, "owner-A", "PX", 5000, "NX");
  assert.equal(okA, "OK");
  log("owner-A acquired lease");

  const extendResult = await client.eval(extendScript, 1, key, "owner-A", "5000");
  log("A extends its own lease via CAS Lua, result:", extendResult);
  assert.equal(extendResult, 1);

  const imposterExtend = await client.eval(extendScript, 1, key, "owner-B", "5000");
  log("B (imposter) tries to extend A's lease via CAS Lua, result:", imposterExtend);
  assert.equal(imposterExtend, 0);

  const imposterRelease = await client.eval(releaseScript, 1, key, "owner-B");
  log("B (imposter) tries to CAS-release A's lease, result:", imposterRelease);
  assert.equal(imposterRelease, 0);
  assert.equal(await client.get(key), "owner-A", "A's lease must survive the imposter's attempts");

  const aRelease = await client.eval(releaseScript, 1, key, "owner-A");
  log("A releases its own lease via CAS Lua, result:", aRelease);
  assert.equal(aRelease, 1);
  assert.equal(await client.get(key), null);

  // Now demonstrate the bug: naive plain DEL used as "release", with no ownership check.
  await client.set(key, "owner-C", "PX", 200, "NX");
  log("owner-C acquired a short (200ms) lease");
  await delay(300); // let C's lease expire on Redis's own clock
  const okD = await client.set(key, "owner-D", "PX", 5000, "NX");
  assert.equal(okD, "OK");
  log("owner-D acquired the now-expired lease");

  // C's release call finally runs (e.g. it was delayed/GC-paused) and does a bare DEL.
  await client.del(key);
  const afterBug = await client.get(key);
  log("after C's naive plain DEL (no CAS check), key value:", afterBug);
  assert.equal(afterBug, null, "BUG reproduced: naive DEL deleted D's live lease, not C's expired one");

  await client.quit();
}

// ---------------------------------------------------------------------------
// TEST 3: monotonically increasing fencing token issued atomically with the
// lease (INCR inside the same Lua script as SET NX).
// ---------------------------------------------------------------------------
async function test3_fencingToken() {
  log("\n=== TEST 3: fencing token issued atomically with the lease ===");
  const client = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  const leaseKey = "lease:doc3";
  const tokenKey = "lease:doc3:fencing";
  await client.del(leaseKey, tokenKey);

  const acquireScript = `
    local ok = redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2])
    if ok then
      local token = redis.call("INCR", KEYS[2])
      return token
    else
      return nil
    end
  `;

  const tokens: number[] = [];
  for (let i = 0; i < 5; i++) {
    const owner = `owner-${i}`;
    const result = await client.eval(acquireScript, 2, leaseKey, tokenKey, owner, "150");
    log(`attempt ${i} owner=${owner} ->`, result);
    if (result !== null) tokens.push(Number(result));
    await delay(200); // let the lease expire so the next owner can acquire
  }
  log("tokens issued across successive owners:", tokens);
  assert.ok(tokens.length >= 3, "expected several successful acquisitions");
  for (let i = 1; i < tokens.length; i++) {
    assert.ok(tokens[i] > tokens[i - 1], `token ${tokens[i]} should be > previous ${tokens[i - 1]}`);
  }

  await client.quit();
}

// ---------------------------------------------------------------------------
// TEST 4: lease expiry is driven by Redis's clock, not the client's. A
// client whose event loop is blocked past the TTL still "believes" it owns
// the lease while Redis has already handed it to someone else (zombie).
// ---------------------------------------------------------------------------
async function test4_zombieLease() {
  log("\n=== TEST 4: zombie lease -- blocked event loop outlives the TTL ===");
  const client = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  const key = "lease:doc4";
  const tokenKey = "lease:doc4:fencing";
  const ttlMs = 300;
  await client.del(key, tokenKey);

  const acquireScript = `
    local ok = redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2])
    if ok then
      local token = redis.call("INCR", KEYS[2])
      return token
    else
      return nil
    end
  `;
  const renewScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  const tokenARaw = await client.eval(acquireScript, 2, key, tokenKey, "owner-A", String(ttlMs));
  assert.ok(tokenARaw !== null, "owner-A should acquire the lease");
  const tokenA = Number(tokenARaw);
  const aOwnsLease = true; // owner-A's in-memory belief that it holds the lease
  log(`owner-A acquired lease with TTL ${ttlMs}ms, fencing token ${tokenA}`);

  // A separate OS process plays "owner-B": it polls independently of A's
  // event loop and, as soon as it wins the lease (well before A's 2000ms
  // block ends, since the TTL is only 300ms), records a Redis-side TIME
  // timestamp -- not its own OS clock -- at the moment of acquisition.
  const challengerCode = `
    const Redis = require("ioredis");
    const client = new Redis({ host: "${REDIS_HOST}", port: ${REDIS_PORT} });
    const acquireScript = ${JSON.stringify(acquireScript)};
    (async () => {
      for (;;) {
        const token = await client.eval(acquireScript, 2, "${key}", "${tokenKey}", "owner-B", "5000");
        if (token !== null) {
          const time = await client.time();
          console.log(JSON.stringify({ token: Number(token), time: time.map(Number) }));
          await client.quit();
          process.exit(0);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
  `;
  const cwd = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, ["-e", challengerCode], { cwd, stdio: ["ignore", "pipe", "inherit"] });
  let childOutput = "";
  child.stdout.on("data", (d) => {
    childOutput += d.toString();
  });
  // Attach the exit listener IMMEDIATELY (before the synchronous block below).
  // The child will very likely exit well before A unblocks (TTL is only
  // 300ms); if we instead attached this listener only after several `await`s
  // post-unblock, the event loop could process the child's exit and emit
  // "exit" with zero listeners attached in between, silently losing the
  // event and hanging forever.
  const childExited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  // Main thread ("owner-A") truly blocks its OWN event loop synchronously for
  // 2000ms via Atomics.wait on a SharedArrayBuffer -- nothing (timers,
  // renewals, I/O callbacks) can run during this window.
  const blockMs = 2000;
  log(`main thread blocking its event loop synchronously for ${blockMs}ms (TTL is ${ttlMs}ms) via Atomics.wait...`);
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const blockStart = Date.now();
  Atomics.wait(sab, 0, 0, blockMs);
  log(`main thread unblocked after ${Date.now() - blockStart}ms of blocking`);

  // Right after unblocking: record Redis's own TIME (this is A's "unblock
  // time" on Redis's clock -- directly comparable to B's acquisition
  // timestamp, which is also Redis's clock) and check A's in-memory belief
  // against reality.
  const unblockTimeRaw = await client.time();
  const unblockTimeMs = Number(unblockTimeRaw[0]) * 1000 + Number(unblockTimeRaw[1]) / 1000;
  log("owner-A: in-memory 'I own the lease' flag right after unblocking:", aOwnsLease);
  assert.equal(aOwnsLease, true, "A's in-memory flag was never invalidated by anything -- it still believes it owns the lease");

  const actualOwner = await client.get(key);
  log("actual current lease owner in Redis right after A unblocks:", actualOwner);
  assert.equal(actualOwner, "owner-B", "Redis already handed the lease to owner-B while A was blocked");
  assert.notEqual(actualOwner, "owner-A", "owner-A is a ZOMBIE: its in-memory flag says true, but Redis disagrees");

  await childExited;
  const challengerResult = JSON.parse(childOutput.trim()) as { token: number; time: [number, number] };
  const bAcquireTimeMs = Number(challengerResult.time[0]) * 1000 + Number(challengerResult.time[1]) / 1000;
  log("owner-B (separate process) Redis-side acquisition TIME (epoch ms):", bAcquireTimeMs, "fencing token:", challengerResult.token);
  log("owner-A Redis-side unblock TIME (epoch ms):", unblockTimeMs);
  const marginMs = unblockTimeMs - bAcquireTimeMs;
  log(`margin: B's Redis-side acquisition happened ${marginMs}ms before A's Redis-side unblock timestamp`);
  assert.ok(
    marginMs > 1000,
    `expected B to have acquired well before A unblocked (wide margin), got margin=${marginMs}ms`,
  );

  // A's CAS renew must fail: Redis's own compare-and-set sees a different
  // owner now and refuses to extend "A's" lease.
  const renewResult = await client.eval(renewScript, 1, key, "owner-A", "5000");
  log("owner-A's CAS renew attempt after unblocking, result:", renewResult);
  assert.equal(renewResult, 0, "A's CAS renew must fail: Redis has already reassigned the lease to B");

  // Fencing token monotonicity across the zombie handoff.
  log("fencing tokens -- A:", tokenA, "B:", challengerResult.token);
  assert.ok(
    challengerResult.token > tokenA,
    `B's fencing token (${challengerResult.token}) must be greater than A's (${tokenA})`,
  );

  log(
    "IMPLICATION: the lease alone is not safe under blocked event loops / GC pauses / " +
      "network partitions. The storage layer must check the fencing token on every write " +
      "from a lease holder and reject any token lower than the highest seen, instead of " +
      "trusting a client's own 'I hold the lock' flag.",
  );

  await client.quit();
}

// ---------------------------------------------------------------------------
// TEST 5: BullMQ jobId dedup, including the completed+removed vs.
// completed+kept cases.
// ---------------------------------------------------------------------------
async function test5_bullmqDedup() {
  log("\n=== TEST 5: BullMQ jobId dedup ===");
  const queueName = "lt-dedup-" + randomUUID().slice(0, 8);
  const queue = new Queue(queueName, { connection: CONNECTION });

  const jobId = "fixed-job-1";
  const job1 = await queue.add("task", { n: 1 }, { jobId });
  const job2 = await queue.add("task", { n: 2 }, { jobId });
  log("job1.id:", job1.id, "job1.data:", job1.data);
  log("job2.id:", job2.id, "job2.data (from the SECOND add call):", job2.data);
  assert.equal(job1.id, job2.id);
  assert.equal(job2.id, jobId);

  const fetched = await queue.getJob(jobId);
  log("getJob() after adding same jobId twice ->", fetched?.data);
  assert.deepEqual(fetched?.data, { n: 1 }, "the second add() must NOT overwrite the first job's data");

  const counts = await queue.getJobCounts();
  log("job counts after adding the same jobId twice:", counts);
  assert.equal(counts.waiting, 1);

  const worker = new Worker(queueName, async () => "done", { connection: CONNECTION });
  await worker.waitUntilReady();

  // Case A: completed job is REMOVED (removeOnComplete: true) -> jobId frees up.
  const jobIdA = "job-completed-removed";
  await queue.add("task", { case: "A" }, { jobId: jobIdA, removeOnComplete: true });
  await new Promise<void>((resolve) => {
    const handler = (job: { id?: string }) => {
      if (job.id === jobIdA) {
        worker.off("completed", handler);
        resolve();
      }
    };
    worker.on("completed", handler);
  });
  await delay(300);
  const afterRemoveJob = await queue.getJob(jobIdA);
  log("case A (removeOnComplete:true): getJob() after completion ->", afterRemoveJob);
  assert.equal(afterRemoveJob, undefined);

  const readdA = await queue.add("task", { case: "A-second" }, { jobId: jobIdA });
  log("case A: re-adding the same jobId after removal -> new job data:", readdA.data);
  assert.deepEqual(
    readdA.data,
    { case: "A-second" },
    "since the old job was removed, the jobId is free and a NEW job is created",
  );

  // Case B: completed job is KEPT (default) -> jobId stays "taken".
  const jobIdB = "job-completed-kept";
  await queue.add("task", { case: "B" }, { jobId: jobIdB });
  await new Promise<void>((resolve) => {
    const handler = (job: { id?: string }) => {
      if (job.id === jobIdB) {
        worker.off("completed", handler);
        resolve();
      }
    };
    worker.on("completed", handler);
  });
  await delay(300);
  const keptJob = await queue.getJob(jobIdB);
  log("case B (default, not removed): job still present, state:", await keptJob?.getState(), "data:", keptJob?.data);
  assert.ok(keptJob, "completed job should still exist since removeOnComplete was not set");

  const readdBAttempt = await queue.add("task", { case: "B-second" }, { jobId: jobIdB });
  log(
    "case B: re-adding the same jobId while old completed job still exists -> " +
      "LOCAL returned Job object's data (misleading, just echoes your input):",
    readdBAttempt.data,
  );
  const persistedAfterReadd = await queue.getJob(jobIdB);
  log("case B: ACTUAL persisted job in Redis after the re-add (source of truth):", persistedAfterReadd?.data);
  assert.deepEqual(
    persistedAfterReadd?.data,
    { case: "B" },
    "a completed-but-not-removed jobId blocks new data: Redis keeps the OLD job untouched",
  );
  assert.deepEqual(
    readdBAttempt.data,
    { case: "B-second" },
    "gotcha: the LOCAL Job object returned by add() echoes your new input regardless -- " +
      "it is NOT proof the write was persisted; you must re-fetch via getJob() to know the truth",
  );

  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
}

// ---------------------------------------------------------------------------
// TEST 6: worker dies mid-job (simulated crash) -> job is picked up again via
// stalled-job recovery. Measure roughly how long it takes and note the
// controlling settings.
// ---------------------------------------------------------------------------
async function test6_stalledJob() {
  log("\n=== TEST 6: worker crash mid-job -> stalled job recovery ===");
  const queueName = "lt-stalled-" + randomUUID().slice(0, 8);
  const queue = new Queue(queueName, { connection: CONNECTION });

  const lockDuration = 1000;
  const stalledInterval = 1000;

  await queue.add("task", { hello: "world" });
  const crashBaseline = Date.now();

  // Worker A picks up the job, then is force-closed mid-processing (simulated
  // crash: no completion, no graceful lock release, no further renewal).
  const workerA = new Worker(
    queueName,
    async () => {
      log("workerA started processing the job");
      await new Promise(() => {}); // hang forever, like a crashed process
    },
    { connection: CONNECTION, lockDuration, stalledInterval },
  );
  await new Promise<void>((resolve) => workerA.on("active", () => resolve()));
  await workerA.close(true); // force-close: no graceful lock release, no job completion
  log("workerA force-closed (simulated crash) at +", Date.now() - crashBaseline, "ms");

  // Worker B is a fresh worker (a replacement process) watching the same queue.
  let reprocessedAt = 0;
  const workerB = new Worker(
    queueName,
    async (job) => {
      reprocessedAt = Date.now();
      log("workerB picked up job", job.id, "attemptsMade:", job.attemptsMade, "at +", reprocessedAt - crashBaseline, "ms");
      return "recovered";
    },
    { connection: CONNECTION, lockDuration, stalledInterval },
  );

  await new Promise<void>((resolve) => workerB.on("completed", () => resolve()));
  const recoveryMs = reprocessedAt - crashBaseline;
  log(
    `job was stalled and re-picked up ~${recoveryMs}ms after being added ` +
      `(lockDuration=${lockDuration}ms, stalledInterval=${stalledInterval}ms)`,
  );
  assert.ok(recoveryMs > 0);
  assert.ok(recoveryMs < 15000, `recovery took suspiciously long: ${recoveryMs}ms`);

  await workerB.close();
  await queue.obliterate({ force: true });
  await queue.close();
}

// ---------------------------------------------------------------------------
// TEST 7: separate queues with separate Worker concurrency do not starve
// each other.
// ---------------------------------------------------------------------------
async function test7_queueIsolation() {
  log("\n=== TEST 7: separate queues/workers don't starve each other ===");
  const queueAName = "lt-isoA-" + randomUUID().slice(0, 8);
  const queueBName = "lt-isoB-" + randomUUID().slice(0, 8);
  const queueA = new Queue(queueAName, { connection: CONNECTION });
  const queueB = new Queue(queueBName, { connection: CONNECTION });

  const longJobMs = 3000;
  let bCompletedAt = 0;

  const workerA = new Worker(queueAName, async () => delay(longJobMs).then(() => "A done"), {
    connection: CONNECTION,
    concurrency: 1,
  });
  const workerB = new Worker(
    queueBName,
    async () => {
      await delay(50);
      bCompletedAt = Date.now();
      return "B done";
    },
    { connection: CONNECTION, concurrency: 1 },
  );
  await workerA.waitUntilReady();
  await workerB.waitUntilReady();

  const t0 = Date.now();
  await queueA.add("long", {});
  await delay(200); // ensure A's long job is already running before B's job is added
  await queueB.add("fast", {});

  await new Promise<void>((resolve) => {
    let done = 0;
    const onDone = () => {
      done++;
      if (done === 2) resolve();
    };
    workerA.on("completed", onDone);
    workerB.on("completed", onDone);
  });

  const bLatency = bCompletedAt - t0;
  log(`queue B's fast job completed ${bLatency}ms after t0, while queue A's long job takes ${longJobMs}ms`);
  assert.ok(
    bLatency < longJobMs,
    `queue B should not be starved by queue A's long job (bLatency=${bLatency}ms, longJobMs=${longJobMs}ms)`,
  );

  await workerA.close();
  await workerB.close();
  await queueA.obliterate({ force: true });
  await queueB.obliterate({ force: true });
  await queueA.close();
  await queueB.close();
}

// ---------------------------------------------------------------------------
// TEST 8: BullMQ's required ioredis connection options -- record exactly
// what it demands.
// ---------------------------------------------------------------------------
async function test8_connectionRequirements() {
  log("\n=== TEST 8: BullMQ's required ioredis connection options ===");

  // 8a: Queue with a plain options object, maxRetriesPerRequest not set at
  // all. Queue never issues blocking commands, so it never touches this.
  const queueName = "lt-conncheck-" + randomUUID().slice(0, 8);
  const q = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } });
  await q.waitUntilReady();
  log("Queue's own connection is non-blocking; it does not require maxRetriesPerRequest at all (no throw, no override).");
  await q.close();

  // 8b: Worker with a plain options object, maxRetriesPerRequest not set.
  // BullMQ's internal blocking connection silently forces it to null.
  const w1 = new Worker(queueName + "-w1", async () => {}, {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
  });
  await w1.waitUntilReady();
  const appliedValue = (w1 as unknown as { blockingConnection: { opts: { maxRetriesPerRequest: unknown } } })
    .blockingConnection.opts.maxRetriesPerRequest;
  log("Worker given a plain object with maxRetriesPerRequest unset -> internally forced to:", appliedValue);
  assert.equal(appliedValue, null);
  await w1.close();

  // 8c: Worker given a pre-built ioredis instance WITHOUT maxRetriesPerRequest:
  // null (ioredis default is 20) -> BullMQ throws synchronously.
  const badConn = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  let threw: Error | null = null;
  let w2: Worker | null = null;
  try {
    // autorun:false avoids a noisy secondary unhandled-rejection: with autorun
    // (the default) BullMQ schedules an internal run() call before the
    // blockingConnection field is even assigned, so once the constructor
    // throws here, that already-scheduled run() blows up separately trying
    // to read the never-assigned this.blockingConnection.
    w2 = new Worker(queueName + "-w2", async () => {}, { connection: badConn, autorun: false });
  } catch (err) {
    threw = err as Error;
  }
  log("Worker given a raw ioredis instance without maxRetriesPerRequest:null ->", threw?.message);
  assert.ok(threw, "expected BullMQ to throw synchronously");
  assert.match(threw!.message, /maxRetriesPerRequest must be null/);
  if (w2) await (w2 as Worker).close();
  await badConn.quit();

  // 8d: Worker given a pre-built ioredis instance WITH maxRetriesPerRequest:
  // null already set -> works fine.
  const goodConn = new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null });
  const w3 = new Worker(queueName + "-w3", async () => {}, { connection: goodConn });
  await w3.waitUntilReady();
  log("Worker given a raw ioredis instance WITH maxRetriesPerRequest:null -> works fine.");
  await w3.close();
  await goodConn.quit();
}

// ---------------------------------------------------------------------------
// TEST 9: FLUSHALL loses queued jobs -- confirms Redis-as-source-of-truth
// would be unsafe; Postgres jobs table + rebuildable Redis is necessary.
// ---------------------------------------------------------------------------
async function test9_flushallLosesJobs() {
  log("\n=== TEST 9: FLUSHALL wipes queued jobs ===");
  const queueName = "lt-flush-" + randomUUID().slice(0, 8);
  const queue = new Queue(queueName, { connection: CONNECTION });

  for (let i = 0; i < 5; i++) {
    await queue.add("task", { i });
  }
  const before = await queue.getJobCounts();
  log("job counts before FLUSHALL:", before);
  assert.equal(before.waiting, 5);

  const flushClient = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  await flushClient.flushall();
  await flushClient.quit();

  const after = await queue.getJobCounts();
  log("job counts after FLUSHALL:", after);
  assert.equal(after.waiting, 0);

  const jobsAfter = await queue.getJobs(["waiting", "active", "completed", "failed", "delayed"]);
  log("total jobs across all states after FLUSHALL:", jobsAfter.length);
  assert.equal(jobsAfter.length, 0, "FLUSHALL destroyed all queued jobs");

  await queue.close();
}

// ---------------------------------------------------------------------------
async function main() {
  await startRedisContainer();
  try {
    const probe = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    await probe.ping();
    const info = await probe.info("server");
    log("connected to Redis:", info.split("\n").find((l) => l.startsWith("redis_version")));
    await probe.quit();

    await test1_atomicLease();
    await test2_casReleaseRenew();
    await test3_fencingToken();
    await test4_zombieLease();
    await test5_bullmqDedup();
    await test6_stalledJob();
    await test7_queueIsolation();
    await test8_connectionRequirements();
    await test9_flushallLosesJobs();

    log("\nALL TESTS PASSED");
  } finally {
    stopRedisContainer();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nTEST FAILURE:", err);
    process.exit(1);
  });
