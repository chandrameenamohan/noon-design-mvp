---
id: peers-converge
a0: 1
observable: two people editing the same document end up looking at the same tree, and it is the tree the server holds
type: always
priority: P0
site: harness:finally_peers_converge
guard: Sometimes("the room applied an op whose sender had not yet seen the room's latest op")
guard_site: apps/sync/src/room.ts:299
evidence: packages/doc-model/src/convergence.test.ts, apps/sync/src/sim.test.ts, scripts/chaos/no-loss.ts:73, e2e/editing.spec.ts:41
---

# peers-converge

**A0 invariant 1: peers converge.**

## Property

Once the workload stops and every peer has heard up to the room's `seq`, each peer's confirmed document
(serialized canonically) equals the room's document and equals a replay of the journal from the latest snapshot.
Holds across sync-node death and failover: the room a peer lands on after reconnecting is judged, not the dead one.

## Assertion (Z.2b)

`finally_peers_converge`: the driver's peers each report their confirmed document; `Always(all equal)` and
`Always(equal to snapshot + journal replay read from Postgres)`. The in-process twin already exists:
`apps/sync/src/sim.ts:132` (caught up but different) and `:201` (did not converge), run on seeded schedules by
`make sim` / `sim.test.ts`.

## Vacuity guard

Convergence is trivial when peers take turns. `Sometimes` at `room.ts:299` (the op is validated against a document
that already moved past its `baseSeq`): concurrent edits really reached the room. Without it a green run may only
have shown serial edits.

## Evidence today

- `packages/doc-model/src/convergence.test.ts`: random concurrent op sequences, pure.
- `apps/sync/src/sim.test.ts`: the committed seeds of the reconcile simulator (SPEC F8a).
- `scripts/chaos/no-loss.ts:73`: every chaos run that kills a sync node compares the peers' confirmed documents
  (`chaos:kill-sync-no-loss`, `chaos:kill-owner-failover`; PASS in the 2026-09 full chaos run).
- `e2e/editing.spec.ts:41`: two browsers, trees end identical.
