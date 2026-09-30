---
id: killed-worker-job-resumes
observable: an AI run, preview or ship whose worker was killed finishes anyway, without duplicate nodes, as its next attempt
type: eventually
priority: P1
site: apps/worker/src/worker.ts:145
guard: Sometimes("a worker was killed while its job was running")
guard_site: scripts/chaos/kill-worker-resumes.ts:92
evidence: scripts/chaos/kill-worker-resumes.ts, apps/worker/src/crash.int.test.ts:48
---

# killed-worker-job-resumes

SPEC §4 "worker dies", F28.

## Property

A job left `running` by a dead worker is put back to `queued` once its heartbeat is stale (`sweepOnce`,
`worker.ts:145`), claimed again, and ends `succeeded` as attempt 2; its steps are journaled once each
([[op-applied-at-most-once]]); a live worker's long job is never taken from it.

## Assertion (Z.2b)

`eventually_jobs_settle`: after faults stop, every job the driver started reaches a terminal status within a
budget; `Always` that a job never retried before its heartbeat was stale (`kill-worker-resumes.ts` checks
`retriedAfterMs >= STALE_MS`).

## Vacuity guard

`Sometimes` that the kill landed mid-run (`kill-worker-resumes.ts:92`: status running, attempt 1, some but not all
steps journaled).

## Evidence today

`chaos:kill-worker-resumes` (ai, sandbox, ship rounds; PASS 2026-09), `crash.int.test.ts:48`, `:64`.
