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

# Existing assertions

No Antithesis SDK is imported anywhere in the SUT (`grep -r antithesis apps packages` is empty at commit 764ad75).
Every `site` in this catalog is therefore MISSING until Z.2b.

What exists and plays the part, to be called from the test template rather than rewritten:

| Check | Where | Properties it already judges |
|---|---|---|
| `noLossViolations` (ledger vs journal, vacuity guards) | scripts/chaos/no-loss.ts:47 | acknowledged-op-never-lost, op-applied-at-most-once, journal-seq-contiguous, peers-converge |
| `runViolations` (every run succeeded once, seqs contiguous, vacuity guards) | scripts/chaos/rebuild.ts:13 | redis-loss-jobs-rebuilt, job-claimed-once-per-attempt, journal-seq-contiguous |
| `leaseViolations` (token monotone, fence = lease) | scripts/chaos/rebuild.ts:31 | one-owner-per-room |
| simulator convergence | apps/sync/src/sim.ts:132, :201 | peers-converge |
| `checkDoc` (the document is a tree) | packages/doc-model/src/index.ts:148 | document-always-a-tree |
| compile-time scope checks | packages/db/src/scope.typecheck.test.ts | no-cross-org-read |
| step checks in `kill-worker-resumes` | scripts/chaos/kill-worker-resumes.ts | killed-worker-job-resumes, one-open-pr-per-document |
