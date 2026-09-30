---
id: superseded-attempt-writes-nothing
observable: a worker that stalled and was given up on cannot overwrite the result, progress or usage of the attempt that replaced it
type: always
priority: P1
site: apps/worker/src/worker.ts:106
guard: Sometimes("a stalled attempt woke up after its job was given to another attempt")
guard_site: apps/worker/src/crash.int.test.ts:81
evidence: apps/worker/src/crash.int.test.ts:81, packages/db/src/job-heartbeat.int.test.ts
---

# superseded-attempt-writes-nothing

F28, E9.2a.

## Property

Everything an attempt writes names it (`mine = { ...ref, attempt }`, `worker.ts:106`); a write under an attempt
that is not the job's latest changes nothing. Complements [[killed-worker-job-resumes]]: that one is about the
dead worker, this one about the one that was only slow (`docker pause` of a worker past `staleMs`).

## Assertion (Z.2b)

SUT: at the job-row writes behind `runAttempt`: `Always("a write under a stale attempt matched no row")`.

## Vacuity guard

`Sometimes` that a paused worker resumed after its job was reclaimed. Today only `crash.int.test.ts:81` reaches it;
no chaos script pauses a worker yet (Z.3 names "worker stalls").

## Evidence today

`crash.int.test.ts:81`, `job-heartbeat.int.test.ts`. No chaos coverage: a gap for Z.3.
