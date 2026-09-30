---
id: room-recovers-after-owner-death
observable: after the sync node holding a document dies, its users are editing again on another node within about one lease ttl
type: eventually
priority: P1
site: harness:eventually_room_writable
guard: Sometimes("the owner of a room with connected peers was killed")
guard_site: scripts/chaos/kill-owner-failover.ts:102
evidence: scripts/chaos/kill-owner-failover.ts:111, apps/sync/src/failover.int.test.ts:66
---

# room-recovers-after-owner-death

SPEC §4 "sync dies", F18/F19.

## Property

After faults stop, every document a driver peer had open accepts an op again, and the time from the kill to the
move is at most one lease ttl plus slack. Liveness: the safety properties hold trivially on a room that never
comes back.

## Assertion (Z.2b)

`eventually_room_writable`: each driver peer submits one op and must get it acknowledged within a budget.
Measurement: the move time (`kill-owner-failover.ts:111` checks it against the ttl) is reported, not only
pass/fail.

## Vacuity guard

`Sometimes` that the killed node was the owner of an open room with peers (not an idle node).

## Evidence today

`chaos:kill-owner-failover` (PASS 2026-09), `failover.int.test.ts:66`.
