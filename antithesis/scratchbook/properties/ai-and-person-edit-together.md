---
id: ai-and-person-edit-together
observable: while the AI is building, a person keeps editing the same document and both see each other's changes
type: sometimes
priority: P2
site: apps/sync/src/room.ts:226
evidence: e2e/ai.spec.ts:9, apps/worker/src/ai.int.test.ts:25
---

# ai-and-person-edit-together

F9, SPEC §8 step 5. Reachability of the interleaving the other properties need.

## Property

At least once in a run, the room accepts an agent op and a user op on the same document with adjacent `seq`s
(interleaved, not one batch after the other).

## Assertion (Z.2b)

SUT: `room.ts:226` (accept): `Sometimes("an agent op and a user op were accepted back to back")`, keyed on the
previous accepted op's actor kind.

## Why it is here

[[peers-converge]], [[op-applied-at-most-once]] and [[acknowledged-op-never-lost]] are all weaker when the only
concurrency is between humans. This tells the explorer the AI + human interleaving was reached.

## Evidence today

`e2e/ai.spec.ts:9`, `ai.int.test.ts:25`.
