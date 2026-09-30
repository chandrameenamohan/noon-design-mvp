---
sut_path: /Users/cm/100x/personal/noon-design-mvp
commit: 764ad75
updated: 2026-10-01
external_references:
  - path: SPEC.md §4a
    why: the harness design; A0 names the seven invariants this catalog starts from
  - path: SPEC.md §4 and §8
    why: the failure modes a user sees, and the end-to-end scenario; the P1 properties come from §4
  - path: /Users/cm/repos/ai-engine/antithesis/scratchbook/
    why: the owner's scratchbook (Conduit); this layout copies its shape (catalog + one evidence file per property)
  - path: /Users/cm/repos/ai-engine/deploy/antithesis/README.md
    why: the owner's harness and its property table (P1..P11, S2..S6 vacuity guards)
---

# Property catalog: Noon (sync rooms, journal, jobs, ship)

## Summary

Twenty-two properties: thirteen `always`, three `unreachable`, four `eventually`, one `sometimes`, one
`reachability`. The first nine are the seven A0 invariants of SPEC §4a (invariant 7, "no duplicate job or PR",
is three properties because it has three observables: a key, a claim, a pull request). Twelve more come from
SPEC §4's failure modes and the guarantees they lean on; one is the reachability table for the fault windows.

Every `always`, `unreachable` and `eventually` names its vacuity guard (a `Sometimes` that proves its path ran)
and where that guard is observed. `make catalog-check` (and the unit test `scripts/catalog-check.test.ts`, so
`make check`) fails when any property lacks an observable, type, priority, site, evidence, or a guard.

**Method.** SPEC §4a asks for Antithesis's `antithesis-research` skill (`npx skills add
antithesishq/antithesis-skills`). It is not installed on this machine, and installing it writes under `.claude/`,
which a builder may not touch. This catalog follows SPEC §4a and copies the shape of the owner's scratchbook in
`~/repos/ai-engine/antithesis/scratchbook/` instead: a catalog file plus `properties/<id>.md`, each the evidence
file for one property.

**No SDK assertion exists in the SUT yet** (out of scope for Z.2a; Z.2b, `deploy/antithesis/`, adds them). What
plays their role today are the pure checks the chaos scripts call: `noLossViolations` (scripts/chaos/no-loss.ts),
`runViolations` and `leaseViolations` (scripts/chaos/rebuild.ts), and the simulator's convergence check
(apps/sync/src/sim.ts). All seven chaos scripts PASSed in the 2026-09 full run. Z.2b should call those functions
from the test template rather than rewrite them.

**Priority scale.** P0: an A0 invariant (data loss, duplicate effect, or a tenant leak). P1: a SPEC §4 failure
mode, or a guarantee a P0 depends on. P2: product-quality or reachability of an interleaving.

**Reading a property file.** Front matter is flat `key: value`, read by `scripts/catalog-check.ts`:
`id`, `a0` (1..7, only for the invariants), `observable` (the business outcome), `type`, `priority`, `site` (the
assertion site: `path:line` in the SUT, or `harness:<test command>` for a check only the driver can make),
`guard` and `guard_site` (for `always`/`unreachable`/`eventually`), `evidence` (the tests or chaos scripts that
exercise it today). The body says what the property is, what Z.2b asserts where, and why the guard matters.

## Catalog

| A0 | id | type | priority | site |
|---|---|---|---|---|
| A0-1 | peers-converge | always | P0 | `harness:finally_peers_converge` |
| A0-2 | acknowledged-op-never-lost | always | P0 | `apps/sync/src/room.ts:226` |
| A0-3 | op-applied-at-most-once | always | P0 | `apps/sync/src/room.ts:346` |
| A0-4 | journal-seq-contiguous | always | P0 | `packages/db/src/index.ts:630` |
| A0-5 | document-always-a-tree | always | P0 | `apps/sync/src/room.ts:223` |
| A0-6 | no-cross-org-read | unreachable | P0 | `harness:anytime_stranger_probe` |
| A0-7 | one-job-per-idempotency-key | always | P0 | `packages/db/src/index.ts:889` |
| A0-7 | job-claimed-once-per-attempt | always | P0 | `apps/worker/src/worker.ts:103` |
| A0-7 | one-open-pr-per-document | always | P0 | `apps/worker/src/ship.ts:161` |
| - | zombie-owner-append-fenced | unreachable | P1 | `packages/db/src/index.ts:630` |
| - | one-owner-per-room | always | P1 | `packages/db/src/index.ts:619` |
| - | storage-outage-visible-read-only | always | P1 | `apps/sync/src/room.ts:233` |
| - | room-recovers-after-owner-death | eventually | P1 | `harness:eventually_room_writable` |
| - | killed-worker-job-resumes | eventually | P1 | `apps/worker/src/worker.ts:145` |
| - | superseded-attempt-writes-nothing | always | P1 | `apps/worker/src/worker.ts:106` |
| - | redis-loss-jobs-rebuilt | eventually | P1 | `apps/worker/src/worker.ts:145` |
| - | no-edit-without-edit-role | unreachable | P1 | `apps/sync/src/room.ts:246` |
| - | revoked-share-loses-access | eventually | P1 | `harness:eventually_revoked_share_closed` |
| - | shipped-page-equals-codegen | always | P1 | `apps/worker/src/ship.ts:105` |
| - | dangerous-windows-reached | reachability | P1 | `harness:finally_windows_reached` |
| - | failed-ai-run-leaves-document-valid | always | P2 | `apps/worker/src/ai.ts:86` |
| - | ai-and-person-edit-together | sometimes | P2 | `apps/sync/src/room.ts:226` |

## What Z.2b must build to assert these

- **An op ledger in the driver** (every submit, its state at the fault, its settled outcome): feeds
  `finally_ledger`, which is `noLossViolations` plus the per-document seq query. Covers A0-2, A0-3, A0-4, and the
  harness half of zombie-owner-append-fenced and no-edit-without-edit-role.
- **Test-template commands** named in the `site`/`guard_site` fields: `finally_peers_converge`, `finally_ledger`,
  `finally_jobs`, `finally_ship`, `finally_windows_reached`, `anytime_stranger_probe`, `anytime_lease_matches_fence`,
  `anytime_journal_contiguous`, `eventually_room_writable`, `eventually_jobs_settle`,
  `eventually_revoked_share_closed`, and drivers `parallel_driver_start_twice` (A0-7) and crossing moves from two
  peers (A0-5's guard).
- **SUT-side SDK calls** at the `path:line` sites (Always/Unreachable) and guard sites (Sometimes), in local-output
  mode. Configuration, not behaviour: an assertion must never change what the code does.
- **A second org and an outside user** in `first_` setup, for no-cross-org-read and revoked-share-loses-access.
- **A slow, multi-step scripted AI stub**, so kills and cancels land mid-run (R4, failed-ai-run-leaves-document-valid).

## Gaps

- No chaos script pauses a **worker** past `staleMs` (R7, superseded-attempt-writes-nothing): only an integration
  test reaches it. Z.3 "worker stalls" should.
- **MinIO down** (SPEC §4 lists it with Postgres) has no chaos script; storage-outage-visible-read-only is evidenced
  for Postgres only.
- no-cross-org-read is evidenced by integration tests, never under faults: the stranger probe is new work in Z.2b.
