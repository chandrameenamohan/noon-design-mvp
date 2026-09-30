---
sut_path: /Users/cm/100x/personal/noon-design-mvp
commit: 764ad75a3db71d412bee986f08a5ff58aeca7200
updated: 2026-10-01
external_references:
  - path: /Users/cm/100x/personal/noon-design-mvp/SPEC.md
    why: §4a names the seven A0 invariants this catalog starts from; §4 (failure modes) and §8 (end-to-end scenario) give the P1 properties
  - path: https://github.com/antithesishq/antithesis-skills/tree/main/antithesis-research
    why: the antithesis-research skill; its references/property-catalog.md and scratchbook-artifacts.md fix this file's format
  - path: /Users/cm/repos/ai-engine/antithesis/scratchbook/
    why: the owner's scratchbook for Conduit, made with the same skill; its catalog rows (Priority, SUT instrumentation) are copied here
  - path: /Users/cm/repos/ai-engine/deploy/antithesis/README.md
    why: the owner's harness and its property table (P1..P11 always, S2..S6 sometimes vacuity guards)
---

# Property Relationships

## Journal truth (the op ledger)
Properties: acknowledged-op-never-lost, op-applied-at-most-once, journal-seq-contiguous, peers-converge
Notes: One observation, the driver's ledger joined with `op_journal`, judges all four (`noLossViolations`,
scripts/chaos/no-loss.ts). Suspected dominance: with a single writer (one-owner-per-room), contiguous seqs plus
at-most-once plus never-lost imply that peers converge if replay is deterministic. peers-converge is kept separate
because it also catches client-side rebase bugs the journal cannot see.

## Single writer
Properties: one-owner-per-room, zombie-owner-append-fenced, journal-seq-contiguous, room-recovers-after-owner-death
Notes: The same mechanism (lease token + `fence_claim` in one insert, packages/db/src/index.ts:619, :630) seen as
safety (fence), invariant (token = fence) and liveness (the room comes back). zombie-owner-append-fenced is a
precondition for journal-seq-contiguous under pauses.

## Storage outage
Properties: storage-outage-visible-read-only, acknowledged-op-never-lost, op-applied-at-most-once
Notes: The held op that "lands once" after storage returns is judged by the two ledger properties; read-only
adds only "no ack while down, and everyone is told".

## Job execution
Properties: one-job-per-idempotency-key, job-claimed-once-per-attempt, killed-worker-job-resumes, superseded-attempt-writes-nothing, redis-loss-jobs-rebuilt, failed-ai-run-leaves-document-valid
Notes: `jobs.claim` + attempt-keyed writes are the shared code path (apps/worker/src/worker.ts:103-106).
killed-worker-job-resumes and redis-loss-jobs-rebuilt are the liveness side of job-claimed-once-per-attempt.
An AI run's replayed steps also depend on op-applied-at-most-once (the same op ids on every attempt, `replayIds`).

## Ship
Properties: one-open-pr-per-document, shipped-page-equals-codegen, one-job-per-idempotency-key
Notes: Same job (apps/worker/src/ship.ts). One-queued-ship-per-document (migration 0011) is shared with the key
property.

## Access
Properties: no-cross-org-read, no-edit-without-edit-role, revoked-share-loses-access
Notes: The stranger probe (no-cross-org-read) also covers "cannot come back" after a revoke; the revoke
property adds only the live session closing.

## Reachability anchors
Properties: dangerous-windows-reached, ai-and-person-edit-together
Notes: Each window R1-R7 in dangerous-windows-reached is the guard of one or more properties above (table in its
evidence file). ai-and-person-edit-together strengthens the journal-truth cluster.
