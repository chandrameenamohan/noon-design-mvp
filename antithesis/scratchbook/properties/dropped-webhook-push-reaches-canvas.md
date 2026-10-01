---
id: dropped-webhook-push-reaches-canvas
observable: an engineer's push to a document's branch shows on the open canvas, once, even when Gitea's webhook delivery for it never arrived
type: eventually
priority: P1
site: harness:eventually_push_on_canvas
guard: Sometimes("a push whose webhook delivery was dropped was recorded by the reconcile")
guard_site: harness:eventually_push_on_canvas
evidence: apps/worker/src/git.int.test.ts:69, apps/worker/src/git.int.test.ts:89, apps/worker/src/push.int.test.ts
---

# dropped-webhook-push-reaches-canvas

F16a, SPEC §2a ("Gitea never retries a failed delivery"). Added by Z.3 (noon-cs6.3): the bead names "webhook dropped"
among its fault scenarios, and no property of the Z.2a catalog was about a push.

## Property

A commit on `noon/<document>` that changes the generated page in shape becomes the git peer's ops in that document's
journal (actor `git`, the commit as the run), exactly once, whichever door recorded it: the api's webhook
(`apps/api/src/app.ts:246`) or, when that delivery is lost, the git peer's reconcile of its mirror
(`apps/worker/src/git.ts:107`, every 30 s and whenever a document is opened). With the document already open and
nobody reopening it, the bound is one reconcile period plus slack.

## Assertion (Z.3)

`eventually_push_on_canvas`: for every push the driver's engineer made (`pushes.jsonl`), the journal holds one row
whose `run_id` is the commit, and it is the pushed change. The `webhook-dropped` scene adds the time bound: the open
peer's confirmed document shows the push within 60 s.

## Vacuity guard

`Sometimes` that a push made while the webhook's listener was cut ended as a `git_events` row with no `delivery_id`
(the reconcile's door) and reached the journal. A run whose every delivery arrived proves only the webhook door.

## Evidence today

`git.int.test.ts:69` (`integration:missed-webhook-reconciled`: the reconcile records a push nobody announced) and
`:89` (the two doors meet at one event); `push.int.test.ts` (a recorded event becomes ops). Never before with a real
Gitea whose delivery was really refused.
