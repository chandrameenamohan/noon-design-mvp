# Lesson 4 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-4/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend the projection, end to end | Give the api `GET /documents/:id/code`: the document's generated TSX as `text/plain`, byte-for-byte what `generate()` makes from the saved document. Touch the api's dependencies (it does not know codegen yet), the error contract (`not_generated`, a name), and the route (membership only; a document nobody opened is the empty page). | `d1-code-route.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-reaper/reaper.ts` is a 50-line reaper with one bug from the chapter planted in it. Read the failing assertion, form a theory, then fix it in that file. The fix moves one line. | `d2-reaper/reaper.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too
(the dead-code check, the lint rule on test-only imports, and the type check will each have an opinion).
D1 talks to the dev Postgres through a throwaway schema, like the api's own tests; it needs `./init.sh`
to have run once, and no Docker beyond that.

Stuck on D2? Section 6 of the chapter ("One queue per process, one pool per stack, a reaper with an
owner") and the row about the reaper in section 10's table. The real fix is the order of two lines in
`apps/worker/src/sandbox.ts`, in `reapSandboxes`.
