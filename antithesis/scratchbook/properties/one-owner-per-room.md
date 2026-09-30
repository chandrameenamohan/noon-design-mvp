---
id: one-owner-per-room
observable: all users of a document are in the same room on the same node; there are never two live copies taking edits
type: always
priority: P1
site: packages/db/src/index.ts:619
guard: Sometimes("a document's room moved to another sync node")
guard_site: scripts/chaos/kill-owner-failover.ts:102
evidence: scripts/chaos/rebuild.ts:34, scripts/chaos/kill-owner-failover.ts, apps/sync/src/one-room-globally.int.test.ts:85
---

# one-owner-per-room

SPEC F19/F21/F22, §4 "Redis lost".

## Property

For each document the lease token only increases (a flushed Redis must not reissue one), and the journal's
`fence_token` names the token of the live lease holder. So at most one node can write, and that node is the one
the router sends peers to.

## Assertion (Z.2b)

- SUT: `index.ts:619`, the claim `update ... where fence_token < $3`: `Always("a claim only moves the fence
  forward")` (rowCount 0 means an older token lost, which is fine; a claim with a lower token that succeeds is the
  failure).
- Harness: `anytime_lease_matches_fence`: Redis `lease:<doc>` token equals `documents.fence_token`
  (`scripts/chaos/rebuild.ts:34-35`, `leaseViolations`).

## Vacuity guard

`Sometimes` that ownership changed at all (kill, pause, Redis wipe). `kill-owner-failover.ts:102` checks the new
token beats the old one after a kill.

## Evidence today

`chaos:kill-owner-failover`, `chaos:redis-wipe-rebuild` (lease before/after in the JSON line: token 1 -> 2),
`one-room-globally.int.test.ts:85`.
