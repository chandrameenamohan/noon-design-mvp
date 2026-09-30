---
id: acknowledged-op-never-lost
a0: 2
observable: an edit a user saw confirmed is still in the document after any crash, failover or storage blip
type: always
priority: P0
site: apps/sync/src/room.ts:226
guard: Sometimes("an op was in flight (sent, not yet acknowledged) when the fault struck")
guard_site: scripts/chaos/no-loss.ts:50
evidence: scripts/chaos/no-loss.ts, scripts/chaos/no-loss.test.ts, scripts/chaos/kill-sync-no-loss.ts, scripts/chaos/kill-owner-failover.ts, apps/sync/src/journal.int.test.ts
---

# acknowledged-op-never-lost

**A0 invariant 2: no acknowledged op lost.**

## Property

Every op whose sender received the acknowledgement (its own op echoed back with a `seq`) is in `op_journal` at
exactly that `seq`, and is in every peer's document after recovery. An op in flight at a fault is either
acknowledged later (after a resend) or refused with a reason the sender saw; never silently dropped.

## Assertion (Z.2b)

- SUT: at `room.ts:226`, the broadcast that is the sender's acknowledgement: `Always("an op is announced only after
  the journal took it")` (the append at `:339` returned, not threw). This is the "durable first" ordering of E6.1a.
- Harness: `finally_ledger` joins the driver's op ledger (every submit and its settled outcome) against the journal:
  the logic is `noLossViolations` in `scripts/chaos/no-loss.ts:47`, already pure and unit-tested; Z.2b calls it and
  turns each violation into an `Always` failure.

## Vacuity guard

`scripts/chaos/no-loss.ts:49-50` already refuse to PASS a run in which no op was acknowledged before the fault, or
none was in flight at it. Z.2b turns these into `Sometimes` so the explorer is told to reach them.

## Evidence today

`chaos:kill-sync-no-loss` and `chaos:kill-owner-failover` (full chaos run 2026-09, 7/7 PASS);
`apps/sync/src/journal.int.test.ts` for the durable-before-announce ordering.
