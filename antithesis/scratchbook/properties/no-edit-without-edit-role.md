---
id: no-edit-without-edit-role
observable: a viewer (or a demoted editor) can watch but never changes the document; their attempt is refused with a reason
type: unreachable
priority: P1
site: apps/sync/src/room.ts:246
guard: Sometimes("an op from a peer without edit rights reached the room and was refused")
guard_site: apps/sync/src/room.ts:247
evidence: e2e/viewer-rejected.spec.ts:10, apps/sync/src/role-change.int.test.ts:78, apps/sync/src/role-change.int.test.ts:103
---

# no-edit-without-edit-role

F24, SPEC §8 step 3.

## Property

No journal row has an actor who, at the moment its op took its turn in the room, lacked edit rights on the
document. Asked when the op's turn comes, not when it arrived: an op queued before a demotion is refused too.

## Assertion (Z.2b)

- SUT: `room.ts:246`: `Unreachable("an op was journaled for a peer that may not edit")`, placed after the append
  with the peer's `mayEdit` re-read.
- Harness: `finally_ledger`: every op the driver's viewer submitted settled as `forbidden`.

## Vacuity guard

`Sometimes` at `room.ts:247` that the refusal path ran; the workload must include a viewer that edits and a
demotion racing an editor's queued ops.

## Evidence today

`e2e/viewer-rejected.spec.ts:10`, `role-change.int.test.ts:78` and `:103`.
