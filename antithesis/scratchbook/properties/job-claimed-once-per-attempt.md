---
id: job-claimed-once-per-attempt
a0: 7
observable: an AI run, preview or ship runs once per attempt: a redelivered or rebuilt queue message never starts it a second time while it lives
type: always
priority: P0
site: apps/worker/src/worker.ts:103
guard: Sometimes("a duplicate or stale queue message found nothing to claim")
guard_site: apps/worker/src/worker.ts:104
evidence: scripts/chaos/rebuild.ts:24, scripts/chaos/redis-wipe-rebuild.ts, apps/worker/src/crash.int.test.ts:98
---

# job-claimed-once-per-attempt

**A0 invariant 7 (jobs): no duplicate job execution.**

## Property

`jobs.claim(ref)` (queued -> running, one statement) is the only way a handler starts. Two messages for one job
(BullMQ redelivery, the Postgres sweep re-offering after a Redis wipe) give one running attempt. `attempts` grows
only when the previous attempt is dead (heartbeat stale).

## Assertion (Z.2b)

- SUT: `worker.ts:103`: `Always("claimed job was queued")` and, per job id, at most one handler running in the
  process at a time.
- Harness: `finally_jobs`: for every run the driver started, `attempts` = 1 + the number of worker kills that landed
  inside it (`scripts/chaos/rebuild.ts:24` is the Redis-wipe form).

## Vacuity guard

`Sometimes` at `worker.ts:104` (`if (!job) return`): a duplicate offer actually arrived and was turned away. The
Redis wipe (sweep re-offers every queued row) is the fault that reaches it.

## Evidence today

`chaos:redis-wipe-rebuild` (two rounds, flush and restart, PASS), `crash.int.test.ts:98`.
