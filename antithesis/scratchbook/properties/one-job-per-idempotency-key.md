---
id: one-job-per-idempotency-key
a0: 7
observable: pressing Start AI or Ship again with the same request (a retry after a timeout) never makes a second run or ship
type: always
priority: P0
site: packages/db/src/index.ts:889
guard: Sometimes("a repeated start was answered with the job its key had made")
guard_site: packages/db/src/index.ts:891
evidence: apps/api/src/idempotency.int.test.ts:33, apps/api/src/idempotency.int.test.ts:53
---

# one-job-per-idempotency-key

**A0 invariant 7 (jobs): no duplicate job.**

## Property

For each `(org, user, key)` at most one job exists; every request with that key within 24 h is answered with it.
A key reused for a different request is refused (`key_reused`, 422) and makes nothing. At most one ship is
`queued` per document (`jobs_one_queued_ship_per_document`, migration 0011).

## Assertion (Z.2b)

- SUT: `index.ts:889`, the insert that claims the key: `Always("a key names one job")` after the transaction.
- Harness: `finally_jobs`: `select key, count(distinct job_id) ... having count > 1` is empty; the driver fires the
  same start twice concurrently and across an api kill (`parallel_driver_start_twice`).

## Vacuity guard

`Sometimes` at `index.ts:891`: the insert found the key taken and the replay path ran. No fire means no retry ever
raced, and the property held vacuously.

## Evidence today

`idempotency.int.test.ts:33` (twenty simultaneous starts, one run), `:53` (twenty ships, one ship).
