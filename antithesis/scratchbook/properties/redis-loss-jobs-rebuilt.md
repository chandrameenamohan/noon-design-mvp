---
id: redis-loss-jobs-rebuilt
observable: after Redis is wiped, every AI run that was waiting or running still finishes, each once, and no document data is lost
type: eventually
priority: P1
site: apps/worker/src/worker.ts:145
guard: Sometimes("jobs were waiting in Redis and running when it was wiped")
guard_site: scripts/chaos/rebuild.ts:15
evidence: scripts/chaos/redis-wipe-rebuild.ts, scripts/chaos/rebuild.test.ts, apps/worker/src/crash.int.test.ts:98
---

# redis-loss-jobs-rebuilt

SPEC §4 "Redis lost", SPEC §2.9 (Redis is not the truth).

## Property

Postgres is the truth: whatever it calls `queued` is offered again by the sweep (`worker.ts:145`), so a FLUSHALL or
a Redis restart ends with every waiting and running job `succeeded`, claimed once
([[job-claimed-once-per-attempt]]), and the room re-owned under a higher token ([[one-owner-per-room]]).

## Assertion (Z.2b)

`eventually_jobs_settle` (shared with [[killed-worker-job-resumes]]); `runViolations` in
`scripts/chaos/rebuild.ts` is the pure form, already unit-tested.

## Vacuity guard

`scripts/chaos/rebuild.ts:15-16` refuse a PASS when nothing was waiting or running at the wipe. That is exactly
the noon-elo.3 lesson (commit 10ed3ee): a fast pipeline outruns a late fault.

## Evidence today

`chaos:redis-wipe-rebuild` flush and restart rounds, PASS 2026-09 (waiting 3, running 4 at the wipe).
