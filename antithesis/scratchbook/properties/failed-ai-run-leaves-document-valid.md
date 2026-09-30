---
id: failed-ai-run-leaves-document-valid
observable: an AI run that fails, times out or is cancelled ends with a clear reason; what it had already made stays, nothing more arrives, and the canvas keeps working
type: always
priority: P2
site: apps/worker/src/ai.ts:86
guard: Sometimes("an AI run ended cancelled, failed or timed out with ops already applied")
guard_site: apps/worker/src/ai.int.test.ts:192
evidence: apps/worker/src/ai.int.test.ts:192, apps/worker/src/ai.int.test.ts:145, e2e/ai.spec.ts:41, e2e/ai.spec.ts:67
---

# failed-ai-run-leaves-document-valid

SPEC §4 "AI token missing or rate-limited", F10, F11.

## Property

A run that ends in anything but `succeeded` has a terminal status with a reason; no op of that run is journaled
after its end; the agent peer has left; the ops applied before the end stay.

## Assertion (Z.2b)

- SUT: `ai.ts:86` (the cancel path): `Always("no op of this run is sent after it ended")`.
- Harness: `finally_jobs`: for every non-succeeded run, `max(journal.created_at where run_id)` <= the run's end.

## Vacuity guard

`Sometimes` that a run ended early WITH ops already applied (cancel mid-run, sync killed mid-run). The stub AI in
the harness must emit several steps slowly enough to be cut.

## Evidence today

`ai.int.test.ts:192` (cancel), `:145` (sync goes away), `:122` (timeout); `e2e/ai.spec.ts:41`, `:67`.
