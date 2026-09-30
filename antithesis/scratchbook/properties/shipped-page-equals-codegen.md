---
id: shipped-page-equals-codegen
observable: the file in the pull request is byte-identical to a fresh codegen of the document as it was when Ship ran
type: always
priority: P1
site: apps/worker/src/ship.ts:105
guard: Sometimes("a ship pushed a commit to the document's branch")
guard_site: apps/worker/src/ship.ts:109
evidence: apps/worker/src/ship.int.test.ts:71, e2e/ship.spec.ts:11
---

# shipped-page-equals-codegen

F13, F17, SPEC §8 step 9.

## Property

The blob written at `ship.ts:105` is `generate(document, manifest)` of the document read at `ship.ts:205`, and the
branch head after the ship holds that blob at `pagePath(documentId)`; a racing push is built on, never over.

## Assertion (Z.2b)

- SUT: `ship.ts:105`: `Always("the blob is the codegen of the document read for this ship")` (hash compare).
- Harness: `finally_ship`: fetch the file from Gitea, run codegen on the document at the ship's recorded `seq`,
  compare bytes.

## Vacuity guard

`Sometimes` at `ship.ts:109` (a commit was made), plus one where the branch moved under the push (the
`branch_busy` retry path).

## Evidence today

`ship.int.test.ts:71`, `:119` (racing push), `e2e/ship.spec.ts:11`.
