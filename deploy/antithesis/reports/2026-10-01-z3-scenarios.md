# Z.3 named fault scenarios and chaos 20 (noon-cs6.3), 2026-10-01

All runs were on the owner's laptop, in the harness's own compose project (`noon-antithesis`, no published port),
beside the live demo. The machine is shared. "Load" is the 1-minute load average from `uptime` at the start and end
of each run (10 cores). Every number below is copied from a run log.

## Verdict

On the final tree, every named scenario passed 3 runs out of 3, `baseline` passed (23/23 properties, 21/21 vacuity
guards, R1..R7 reached), and `chaos 20` passed 20 rounds out of 20.

One product fault was found and fixed: a sync node died when a client reset a connection the node had refused
(finding 1). Two more product findings are written down and not fixed, because neither breaks a promise of the spec
(findings 2 and 3). The timeout on every MinIO call (`noon-mo3.3.1`) is kept, with its unit test; no scenario here
depends on it (finding 4). Six harness bugs were fixed (H1 to H6).

## The runs

### Final tree (all fixes in), 23:28 to 23:59

| scenario | runs | PASS | load | what the runs showed |
|---|---|---|---|---|
| store-unavailable | 3 | 3 | 4.5-13.4 | all three peers told read-only; 0 ops acknowledged while Postgres was cut; the held op landed at seq 2 |
| store-slow (600 ms) | 3 | 3 | 4.5-13.4 | every journal call logged slow took 601-615 ms; nothing else |
| sync-killed | 3 | 3 | 5.8-14.6 | the room moved to the other node in 2721, 2958 and 3728 ms (ttl 4000) |
| sync-paused | 3 | 3 | 7.9-16.0 | the frozen owner's late append met the fence; the room moved under token 2 |
| worker-killed | 3 | 3 | 10.5-26.7 | attempt 2 began 62772, 62989 and 62874 ms after the dead worker's last beat (README finding 2) |
| worker-paused | 3 | 3 | 10.5-26.7 | attempt 2 finished; 40 ops, 40 nodes, 1 usage row; the woken attempt wrote nothing |
| redis-wiped | 3 | 3 | 9.7-18.4 | 3 runs waiting and 4 running at the FLUSHALL; all succeeded, claimed once; the room came back under a larger token |
| webhook-dropped | 3 | 3 | 6.5-18.4 | the control push came by the webhook; the push made with the listener cut came by the reconcile, on the canvas after 27891, 27490 and 26892 ms |
| worker-store-unavailable | 3 | 3 | 6.2-14.8 | heartbeat 7.0 s old (staleMs 6 s) when Postgres came back; all three runs ended succeeded as attempt 1 |
| upgrade-reset (new) | 3 | 3 | 5.4-11.2 | 20 refused upgrades reset at the owner; its peers stayed connected; the room kept token 1 on the same node |
| minio-unavailable | 3 | 3 | 5.4-10.7 | the reopened document did not load while MinIO was away; both edits refused `not_ready`; after: live, new edits at seq 27, 28 |
| minio-stalled | 3 | 3 | 5.5-8.0 | the same |
| minio-unavailable open | 3 | 3 | 5.7-7.5 | the same, after 30 edits made while the room could not snapshot |
| minio-stalled open | 3 | 3 | 4.8-7.5 | the room was still held (its last snapshot was hanging), so the peers joined it and their edits landed at seq 57, 58 |
| baseline (baseline-5) | 1 | 1 | 8.1-8.2 | 23/23 PASS, 21/21 guards |
| chaos 20 (chaos-20-b) | 20 rounds | 20 | 4.6-32.9 | 5 worker-store-unavailable; 2 each of minio-unavailable, redis-wiped, store-unavailable, upgrade-reset, webhook-dropped; 1 each of minio-stalled, sync-killed, sync-paused, worker-killed, worker-paused; no store-slow |

### Earlier runs, the same day

| run | result | load | note |
|---|---|---|---|
| each of the nine pre-Z.3 and Z.3 scenarios, 3 runs (21:22-21:50) | 26 PASS, 1 FAIL | 5.6-19.8 | the FAIL is worker-store-unavailable r3: H5 |
| minio-* in their four forms, 3 runs each (21:13-21:50) | 12 PASS | 5.7-11.9 | the new scene (H1) |
| baseline-1 (21:50) | FAIL | 8.6 at start, 76 at the peak | finding 1 was found here; the rest is the machine (below) |
| baseline-2, -3, -4 (22:29-22:44) | 3 PASS, 23/23, 21/21 | 3.3-14.6 | |
| chaos 20, first (chaos-20, 22:44) | 19 PASS, 1 FAIL | 4.0-33.1 | round 18, worker-store-unavailable: H5 again |
| worker-store-unavailable r4-r9, after the H5 fix | 6 PASS | 5.6-20.0 | r7 ended as attempt 2, and passed |
| upgrade-reset without the fix | 2 FAIL | 8.0-11.3 | `sync-2=exited` both times: finding 1 |
| upgrade-reset with the fix | 3 PASS | 6.4-10.1 | |
| minio-stalled (both forms) without the timeout | 6 PASS | 8.5-15.7 | finding 4 |
| store-slow 2000 | could not finish | 11.0-13.4 | finding 2 |

### baseline-1: the machine, not the product (except finding 1)

baseline-1 started at load 8.6 (times in this report are IST, UTC+5:30; the SUT logs are UTC). From about 21:55
the load rose to 76 (22:00) and stayed above 44 until about 22:24; swap was 13.1 of 14 GB. The harness's Postgres
restarted in crash recovery at 16:41 UTC (22:11), and so did the live demo's Postgres (16:48 and 16:49 UTC: "server process ... was terminated by signal 13", "database system was not properly
shut down"). Under that, three scenes timed out (worker-paused: no takeover in 126 s; redis-wiped: peers not live in
60 s; webhook-dropped: the ship failed), seven wiped runs failed, and nine rooms could not be probed. None of this is
called a product FAIL: the stores themselves were restarting. baseline-2, -3, -4 and -5, at load 3 to 15, passed.

One thing in baseline-1 was not the machine: `sync-2` died at 16:31:28 UTC of an unhandled `ECONNRESET`. That is
finding 1, reproduced without load in a unit test and in the new `upgrade-reset` scenario.

## Findings

### 1. A reset on a refused connection killed the sync node (product, fixed in `noon-cs6.3`)

- **Sequence.** A client opens a WebSocket upgrade to a sync node with no valid token (or not to a document path).
  The node answers 401 with `socket.end()`. The client then resets the TCP connection instead of closing it: a
  killed process, a closed laptop, a scanner. In baseline-1 it was the driver's scene process, ending on a timeout
  with a connection still open.
- **False belief.** "Errors on this socket are handled." Node's http server stops listening for a socket's errors
  when it hands the socket over with the `upgrade` event. `apps/sync/src/server.ts` added its own listener only on
  the path that admits the peer, after the token check.
- **Consequence.** The `ECONNRESET` was an `error` event with no listener: an uncaught exception, and the process
  exited. Every room on the node dropped. No data was lost (the journal holds every acknowledged op, and the rooms
  came back on the other node), but no token is needed to do it: anyone who can reach the port can stop a node.
  The harness's own check (`crashes`) caught it: `not running, beyond the fault's own victim: [ sync-2=exited]`.
- **Smallest fix.** Listen for the socket's errors first thing in the `upgrade` handler, before anything can refuse
  it (`apps/sync/src/server.ts`).
- **Regression test.** `apps/sync/src/refused-upgrade.test.ts` (unit, so in `make check`): 20 refused upgrades, each
  reset before or just after the 401, then `/health`. Without the fix it fails, listing the uncaught `read ECONNRESET`
  errors (and a `write EPIPE`); with it, it passes.
- **Scenario.** New: `run.sh upgrade-reset` (in `chaos` too). Without the fix: 2 of 2 FAIL (`sync-2=exited`, the
  room moved from token 1 on sync-2 to token 2 on sync). With it: 3 of 3 PASS, then 3 of 3 more on the final tree,
  and 2 chaos rounds.
- **Proposed bead:** "A client resetting a refused WebSocket upgrade crashed the sync node (no token needed)" (fixed).

### 2. A slow Postgres makes opening a document slow, and at 4 s per answer impossible (product, not fixed)

`store-slow 2000` could not finish: `parallel_driver_edit` timed out after 20 s "waiting for: both editors live".
It is not the machine. Two peers opening one new document, with toxiproxy delaying every Postgres answer to the
sync nodes (same machine, load 10 to 16 throughout):

| latency per answer | both peers live after | client retries |
|---|---|---|
| 1 ms | 0.15 s | 0 |
| 600 ms | 5.7 s | 0 |
| 1000 ms | 11.5 s | 1 |
| 2000 ms | 34.5 s | 4 |
| 3000 ms | 46.7 s | 5 |
| 4000 ms | never, in 150 s | 20 |

- **Sequence.** From the code: opening takes one answer for the role check before the upgrade, then fence, claim,
  load, journal rows since the snapshot and the role again: six answers in a row, and a new pooled connection costs
  about three more for its handshake. The client gives up on a welcome after 10 s of silence (its watchdog checks every 5 s, so it acts at
  10 to 15 s) and dials again. A room whose only peer left while it loaded is closed when the load ends.
- **False belief.** "A connection that has heard nothing for 10 s is dead." Here the node is alive and still loading.
- **Consequence.** At 2 s per answer a document opens in 34 s, each peer on its third try. At 4 s, a retry arrives before the
  last try's connection is back in the pool, opens a new one, and the cycle never ends: the document cannot be opened
  while Postgres answers in 4 s, although every single query is under the 5 s journal timeout. Edits, once open, are
  slower and nothing else (a submit took 4.1 s at 2000 ms and 6.1 s at 3000 ms). Nothing is lost.
- **Why not fixed here.** The spec promises nothing for a slow store (§4 names "down", not "slow"), and the fix is a
  protocol change, not a line. `store-slow` keeps its 600 ms default, which passes; run.sh says where it stops.
- **Smallest fix.** Have the node say something to a connection while its room loads (a status frame every few
  seconds), so the client's silence clock sees a live node; and keep one pooled Postgres connection warm.
- **Proposed bead:** "Opening a document needs about nine sequential Postgres answers and the client gives up after
  10 s: at 4 s per answer it never opens".

### 3. A job-store outage longer than staleMs can restart a healthy AI run (product, by design, not fixed)

- **Sequence.** `worker-store-unavailable` cuts Postgres from the api and the workers mid-run until the job's
  heartbeat is older than `staleMs`. When Postgres returns, it is a race: the worker's next beat, or a sweep (any
  worker process's) that finds the beat stale and puts the job back to `queued`.
- **What happens.** When the sweep wins, the run is given away; attempt 1 logs "job taken over after a silence:
  stopping this attempt" and stops; attempt 2 starts from step one and finishes. Each step is journaled once.
  Observed: attempt 2 in 3 of 21 runs (named r3 and r7, chaos-20 round 18), attempt 1 in the other 18.
- **Why it is not a FAIL.** `worker.ts` says so: a job whose beat is older than `staleMs` is treated as left by a dead
  worker, "and if it is [not], the attempt fence makes the slow worker stop instead of finishing twice". The catalog
  says `attempts` grows only when "the previous attempt is dead (heartbeat stale)", and it was stale. The scene's
  expectation (always attempt 1) was the harness's mistake: H5.
- **Consequence.** With a real model, the restarted run calls the model again from the start: the run's cost twice.
- **Smallest fix, if wanted.** Before requeueing, let a worker that has just regained Postgres beat once (or have the
  sweep skip for one beat period after its own Postgres errors).
- **Proposed bead:** "A Postgres outage longer than staleMs can restart a healthy AI run from step one (a second model call)".

### 4. The timeout on every MinIO call (`noon-mo3.3.1`): kept, no scenario needs it

The verifier's hang is real: with the timeout disabled, `snapshots.test.ts`'s "a MinIO that accepts the connection
and never answers" times out at 4 s; with it, the three calls reject in under 2 s. But the harness cannot show it.
Built from the committed tree (no timeout), `minio-stalled` and `minio-stalled open` passed 6 runs of 6. Toxiproxy's
`timeout` toxic closes the connections it holds when it is removed, so the hung call ends at heal time either way.
With the timeout, the sync log says `snapshot 50 failed: MinIO did not answer within 10000 ms` during the stall; without
it, the call simply waits. A MinIO that never answers and never closes (a black hole) is what the timeout is for.
It stays, as its own commit, with its unit test.

### Harness bugs (fixed)

- **H1. The MinIO scene expected edits made before the document loaded to be held.** The client refuses them at
  once (`not_ready`, "The document has not loaded yet": `packages/peer-client/src/replica.ts`, `apps/web/src/reasons.ts`):
  it holds an edit only after a welcome. The scene now holds each edit made while MinIO is away to what the client
  promises: refused as not loaded, or (when a room still held the document) landed; and after MinIO is back, the
  document opens and takes new edits. Before: 3 of 4 runs FAIL. After: 24 of 24 PASS.
- **H2. A container found dead failed only a chaos round.** A named scenario and `baseline` printed it and still
  exited 0. Now any run with a dead app container (beyond the fault's own victim) is a FAIL.
- **H3 (`noon-cs6.4.1`). Every chaos round printed `crashes.log: No such file or directory`.** The redirect was read
  before `2>/dev/null`. Now `cat ... 2>/dev/null | tr`. chaos-20 and chaos-20-b: 0 such lines.
- **H4 (`noon-cs6.4.2`). worker-paused never ran the `anytime_` checks.** It does now, after the fault opens, like
  the other scenarios (baseline-3: stranger probe, journal contiguous, lease = fence, under the frozen worker). The
  README now names the two scenarios that leave the stranger's probe until their fault is over, and why.
- **H5. worker-store-unavailable held the run to attempt 1.** See finding 3. The scene now notes the attempts the
  run really had, capped at 2, so `finally_jobs` still fails a third claim, a failed run or a step journaled twice.
  Before: FAIL in 2 of 7 runs. After: 9 of 9 named runs (one of them attempt 2) and 5 chaos rounds PASS.
- **H6. `run.sh` with no argument failed to print its usage when called by a relative path** (`sed` read `$0` after
  the `cd`). It reads the script by its own directory now.

## How to repeat

```bash
deploy/antithesis/run.sh up
deploy/antithesis/run.sh upgrade-reset         # or any of the twelve names in run.sh
deploy/antithesis/run.sh baseline
deploy/antithesis/run.sh chaos 20
deploy/antithesis/run.sh down
```
