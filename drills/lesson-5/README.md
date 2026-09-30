# Lesson 5 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-5/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend a type, end to end | Carry the pusher's login from Gitea's payload to the conflict banner: the webhook reading (`apps/api/src/webhook.ts`), a migration (`pusher` on `git_events` and `document_conflicts`, with a check), the db store, the `Conflict` contract, the route, `keepConflict`, and `conflictWords` (`who`). A login the rule refuses is dropped, never a reason to lose the push. | `d1-who-pushed.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-three-way/push-ops.ts` is "a push becomes ops" cut down to adds, props and removes, with one bug from the chapter planted in it. Read the failing assertion, say which side's work got undone, then fix it in that file. The fix changes one line. | `d2-three-way/push-ops.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too (the
existing webhook and conflict tests build bodies without a pusher, and the type checker will name every
place a `Conflict` is made without one; that list is the drill). D1 talks to the dev Postgres through a
throwaway schema, like the api's own tests; it needs `./init.sh` to have run once, and no Docker beyond that.

Stuck on D2? Section 6 of the chapter ("A push becomes ops: git is a peer") and the row about the two-way
diff in section 11's table. The real answer is one expression in `apps/worker/src/push-ops.ts`: what `from` is.
