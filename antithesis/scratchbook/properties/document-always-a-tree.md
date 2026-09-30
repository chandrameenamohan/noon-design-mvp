---
id: document-always-a-tree
a0: 5
observable: the layers panel always shows a tree: no node is its own ancestor, none appears twice, none is orphaned
type: always
priority: P0
site: apps/sync/src/room.ts:223
guard: Sometimes("a move into the node's own subtree was refused as a cycle")
guard_site: packages/doc-model/src/validate.ts:55
evidence: packages/doc-model/src/validate.test.ts, packages/doc-model/src/robustness.test.ts, apps/sync/src/sim.test.ts, e2e/editing.spec.ts:83
---

# document-always-a-tree

**A0 invariant 5: no cycle.**

## Property

After every applied op the room's document passes `checkDoc` (packages/doc-model/src/index.ts:148-): the root has
no parent, every other node is some node's child exactly once, every node is reachable from the root. Two
concurrent moves (A under B, B under A) must not both land.

## Assertion (Z.2b)

- SUT: right after `applyOpInto` at `room.ts:223`: `Always("the room's document is a tree", { problems })` with
  `checkDoc(doc)`. Costs a walk per op; gate it on the SDK being present (local-output mode) so production pays
  nothing.
- Harness: `finally_peers_converge` runs `checkDoc` on every peer's document too.

## Vacuity guard

`Sometimes` at `validate.ts:55`: an op that WOULD make a cycle was seen and refused. The workload must issue
crossing moves from two peers; without this the always is only ever tested on serial, sane moves.

## Evidence today

`validate.test.ts` (cycle refused), `robustness.test.ts` (random ops never break the tree), the simulator seeds.
