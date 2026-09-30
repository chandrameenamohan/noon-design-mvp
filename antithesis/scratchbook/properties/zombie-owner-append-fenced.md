---
id: zombie-owner-append-fenced
observable: a sync node that was frozen past its lease and wakes up cannot change the document; users on the new owner never see its writes
type: unreachable
priority: P1
site: packages/db/src/index.ts:630
guard: Sometimes("a room's append was refused as Fenced and the room gave itself up")
guard_site: apps/sync/src/fence.ts:17
evidence: scripts/chaos/fenced.ts, packages/db/src/fence.int.test.ts:97, packages/db/src/fence.int.test.ts:112
---

# zombie-owner-append-fenced

SPEC §4 "Zombie sync", F22.

## Property

Once a newer owner has claimed the document (`fence_token` raised, `fence_claim` renamed), no append carrying the
old claim lands in `op_journal`. The claim check and the insert are one statement (`index.ts:630`, `FOR UPDATE`),
so a claim racing an append either waits for it or makes it insert nothing.

## Assertion (Z.2b)

- SUT: `index.ts:630`: `Unreachable("an append landed with a claim that is not the document's")`; observable only
  by re-reading `fence_claim` in the same transaction, so in practice the harness form below.
- Harness: `finally_ledger`: every journal row's writer (the node the driver saw acknowledge it) held the lease at
  that `seq`; the old owner's log shows "lease N lost|fenced" (`scripts/chaos/fenced.ts:158`).

## Vacuity guard

`Sometimes` at `fence.ts:17`: `Fenced` was actually thrown to a room. `docker pause` past the lease ttl and a
sync-to-Redis partition both reach it; a pause shorter than the ttl does not.

## Evidence today

`chaos:fenced zombie` and `chaos:fenced partition` (PASS 2026-09); `fence.int.test.ts:112` is the naive control that
shows the race is real without the one-statement fence.
