---
id: op-applied-at-most-once
a0: 3
observable: a click that was sent twice (retry after a dropped connection) changes the document once
type: always
priority: P0
site: apps/sync/src/room.ts:346
guard: Sometimes("the room answered a resend from the journal with its original row")
guard_site: apps/sync/src/room.ts:286
evidence: scripts/chaos/no-loss.ts:56, apps/sync/src/journal.int.test.ts, apps/worker/src/replay.test.ts, scripts/chaos/rebuild.ts:25
---

# op-applied-at-most-once

**A0 invariant 3: no op applied twice.**

## Property

For every `(document, sender, opId)` there is at most one journal row, and the document reflects it at most once.
A resend (the sender never saw its acknowledgement) is answered with the original row, from the room's memory
(`room.ts:261`) or from the journal (`room.ts:286`, `:346`), never applied again. An AI run retried after its worker
died replays its steps under the same op ids (`replayIds`, F28), so the same rule covers the agent peer.

## Assertion (Z.2b)

- SUT: `room.ts:346`, the branch where the journal's unique key `op_journal_op` caught a resend the room had
  forgotten: `Always("a resend caught by the journal is not applied")` (the function returns before `accept`).
- Harness: `finally_ledger`: no opId journaled twice (`scripts/chaos/no-loss.ts:56`); per AI run, ops = opIds =
  nodes (`scripts/chaos/rebuild.ts:25`).

## Vacuity guard

`Sometimes` at `room.ts:286`: a resend reached the journal lookup and was found. If this never fires, the run never
produced a resend the room had forgotten, and the at-most-once path is untested. The cheaper memory hit at `:261`
is a second, weaker `Sometimes`.

## Evidence today

`chaos:kill-sync-no-loss` (in-flight ops resent after the kill), `chaos:kill-worker-resumes` (AI run resumed as
attempt 2, each step once), `apps/worker/src/replay.test.ts`.
