# Lesson 2 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-2/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend the protocol | Presence also says whether a peer is `typing`. Touch the contract (both directions), the room, and optionally the client and the canvas. Decide: required or optional, and why. | `d1-typing.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-replica/replica.ts` is a 60-line replica with one bug from the chapter planted in it. Read the failing assertion, form a theory, then fix it in that file. | `d2-replica/replica.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too.

Stuck on D2? Section 8 of the chapter ("Optimistic editing") and the second case in section 14's table. The real
fix is one condition in `packages/peer-client/src/replica.ts`, in `onOp`.
