---
id: journal-seq-contiguous
a0: 4
observable: a document's history has no missing and no repeated step, so any replay rebuilds the same page
type: always
priority: P0
site: packages/db/src/index.ts:630
guard: Sometimes("a journal append failed while ops were flowing")
guard_site: apps/sync/src/room.ts:341
evidence: scripts/chaos/no-loss.ts:53, scripts/chaos/rebuild.ts:26, packages/db/src/fence.int.test.ts:97, packages/db/src/journal.int.test.ts
---

# journal-seq-contiguous

**A0 invariant 4: no `seq` gap or duplicate.**

## Property

For every document the journal's `seq` values are exactly `1..n` (or `k..n` above the latest snapshot's `seq`),
no gap and no repeat, whatever failed on the way: a failed append, a fenced zombie, an owner change.

## Assertion (Z.2b)

- SUT: `packages/db/src/index.ts:630`, the only insert into `op_journal`: `Always("seq is the next number")`
  (`op_journal_seq` makes a repeat impossible; a gap is only visible from outside).
- Harness: `anytime_journal_contiguous` / `finally_ledger`: `select count(distinct seq) = max(seq) - min + 1`
  per document (the query `scripts/chaos/rebuild.ts:26` and `kill-worker-resumes.ts` already run).

## Vacuity guard

"A failed write leaves no gap" (room.ts:334-335) only matters if a write fails. `Sometimes` at `room.ts:341` (the
append threw and the op was refused `unavailable`) proves the run reached it. Postgres cut, paused, or the room
fenced all reach it.

## Evidence today

`packages/db/src/fence.int.test.ts:97` (20 real races: no gap, no duplicate), `chaos:fenced zombie|partition`,
`chaos:redis-wipe-rebuild`, `chaos:kill-worker-resumes` (all PASS 2026-09).
