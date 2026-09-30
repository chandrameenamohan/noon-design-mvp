# Lesson 7 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-7/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend a type, end to end | Carry the sync node's id from the lease to the screen: `SessionResponse` gains an optional, validated `nodeId` (`packages/contracts`), `syncRouter` answers `{ wsUrl, nodeId }` and a single node `{ wsUrl }` (`packages/lease/src/lease.ts`), `/session` puts it in the response (`apps/api/src/app.ts`), peer-client exposes `nodeId` from its last session, `onNode(nodeId)` in `apps/web/src/reasons.ts` says "on sync-2", and the canvas's status line shows it. | `d1-which-node.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-fenced-room/room.ts` is the room cut down to the fence (queue, claim, fenced append, drop) with one bug from the chapter planted in it. Read the failing assertion, say which row is in the journal that the new owner's room has never seen, then fix it in that file. The fix replaces two calls with one. | `d2-fenced-room/room.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too (the type checker
will name every caller of `syncRouter`'s result, in the api, the worker, `apps/sync/src/testing.ts`, the one-room
integration tests and `failover.int`; that list is the drill). Neither drill needs Docker or the dev database: both are pure.

Stuck on D2? Section 4 of the chapter ("The fence: the check and the write are one statement") and the naive control in
`packages/db/src/fence.int.test.ts`. The real answer is one SQL statement in `append` of `packages/db/src/index.ts`:
`insert ... select ... from documents where ... fence_claim is not distinct from $9 for update`. A check in app code,
then a write, has an `await` between them, and a process can be frozen for a minute inside an `await`.
