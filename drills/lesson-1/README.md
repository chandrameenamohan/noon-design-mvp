# Lesson 1 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-1/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend a type | Give a workspace an optional `description` (at most 500 characters, no control characters). Touch the contract, a NEW migration, the db layer and the route. Do not edit migration 0001. | `d1-extend-a-type.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-cursor/cursor.ts` pages through rows but loses some. Find out why and fix it in that file. | `d2-cursor/cursor.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's last section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too.
