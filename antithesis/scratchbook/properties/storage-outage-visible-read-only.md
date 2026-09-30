---
id: storage-outage-visible-read-only
observable: when Postgres or MinIO is down, every user sees "read-only" and no edit is confirmed; nothing is silently dropped
type: always
priority: P1
site: apps/sync/src/room.ts:233
guard: Sometimes("a room went read-only because its journal failed")
guard_site: apps/sync/src/room.ts:234
evidence: scripts/chaos/postgres-down-read-only.ts, apps/sync/src/read-only.int.test.ts:52, apps/sync/src/read-only.int.test.ts:88
---

# storage-outage-visible-read-only

SPEC §4 "Postgres or MinIO down", E6.1b.

## Property

The first failed (or hung, past `journalTimeoutMs`) append turns the room read-only and tells EVERY peer before the
refusal that caused it; while read-only no op is acknowledged (`room.ts:250-252`); when storage returns, the
held op lands once.

## Assertion (Z.2b)

- SUT: `room.ts:233`: `Always("read-only is broadcast before any refusal it causes")`; `room.ts:252`:
  `Always("no ack while read-only")`.
- Harness: `finally_ledger` covers "lands once" through [[acknowledged-op-never-lost]] and
  [[op-applied-at-most-once]].

## Vacuity guard

`Sometimes` at `room.ts:234` (the broadcast): the run actually cut or paused Postgres while a room was open.

## Evidence today

`chaos:postgres-down-read-only` (PASS 2026-09); `read-only.int.test.ts:52` (down), `:88` (hangs).
