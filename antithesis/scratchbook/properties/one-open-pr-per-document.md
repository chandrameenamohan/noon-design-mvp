---
id: one-open-pr-per-document
a0: 7
observable: pressing Ship twice (or a ship retried after its worker died) leaves exactly one open pull request for the document in Gitea
type: always
priority: P0
site: apps/worker/src/ship.ts:161
guard: Sometimes("ship found the branch's pull request already open (409) and reused it")
guard_site: apps/worker/src/ship.ts:163
evidence: e2e/ship.spec.ts:11, apps/worker/src/ship.int.test.ts, scripts/chaos/kill-worker-resumes.ts
---

# one-open-pr-per-document

**A0 invariant 7 (PRs): no duplicate PR.**

## Property

For every document there is at most one open pull request whose head is the document's branch, whatever number
of ships, concurrent presses, or killed ship workers.

## Assertion (Z.2b)

- SUT: `ship.ts:161`, the `POST /pulls`: `Always("at most one open pull for this branch")` after the 409 path has
  resolved to the existing one.
- Harness: `finally_ship`: list Gitea's open pulls per branch; `Always(count <= 1)`.

## Vacuity guard

`Sometimes` at `ship.ts:163`: the second ship met the first one's pull request. Without it, one ship per document
proves nothing about duplicates.

## Evidence today

`e2e/ship.spec.ts:11` (Ship twice, one open PR), `chaos:kill-worker-resumes` ship round (worker-ship killed mid-ship,
one PR after the retry).
