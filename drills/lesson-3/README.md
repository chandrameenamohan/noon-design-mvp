# Lesson 3 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-3/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend the agent's abilities | Give the agent a seventh tool, `read_node`: one node and everything under it. Touch the tool (its shape is the contract with the model), the system prompt (the list of abilities), and the init check that pins "exactly our six tools". | `d1-read-node.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-run/run.ts` is a 60-line run with one bug from the chapter planted in it. Read the failing assertion, form a theory, then fix it in that file. | `d2-run/run.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too.
D1's last test starts the real Agent SDK and stops at its init message: it needs no credentials and spends
nothing, but it takes a few seconds.

Stuck on D2? Section 3 of the chapter ("Everything a program awaits needs an end") and the eighth row of
section 10's table. The real fix is one condition in `apps/worker/src/ai.ts`, in the wait for `live`.
