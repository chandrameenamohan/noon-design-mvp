# Lesson 6 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-6/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend a type, end to end | Carry the moment the room fell read-only from the room's lent clock to the canvas: the `status` message gains `at` and the welcome `readOnlySince` (`packages/contracts`), the room stamps them from `now()` (`apps/sync/src/room.ts`), peer-client exposes `readOnlySince`, `readOnlyFor(since, now)` in `apps/web/src/reasons.ts` turns it into "5 s" or "2 min", and the canvas's alert says "Read-only for 2 min". | `d1-since-when.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-durable-room/room.ts` is the room cut down to durability (queue, dedupe, journal, read-only, recover) with one bug from the chapter planted in it. Read the failing assertion, say who heard of something the database refused, then fix it in that file. The fix moves one line. | `d2-durable-room/room.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too (`room.test.ts`,
`peer.test.ts` and `wire.test.ts` build and expect statuses without `at`, and the type checker will name every place a
status is made without one; that list is the drill). Neither drill needs Docker or the dev database: both are pure.

Stuck on D2? Section 1 of the chapter ("The journal: durable before anyone hears of it") and the first row of section 8's
table. The real answer is the order of two statements in `handle()` of `apps/sync/src/room.ts`: what happens before
`accept(sequenced)`.
