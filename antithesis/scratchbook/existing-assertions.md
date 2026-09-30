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
