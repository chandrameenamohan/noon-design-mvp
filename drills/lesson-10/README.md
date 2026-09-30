# Lesson 10 drills

Do these alone, before reading the answers in the chapter. Each coded one starts RED.

    sh drills/lesson-10/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend the registry, end to end | The canvas answers Delete and Backspace by removing the selected element, the way every key in the editor works: ONE row in `apps/web/src/shortcuts.ts` (`scope: "canvas", action: "remove"`) drives the handler and the `?` sheet; `Surface.tsx` gains an `onRemove: (id: string) => void` prop and a `case "remove":` that calls it for the selected node and never for the page; `Canvas.tsx` passes `onRemove={(id) => { submit({ type: "remove_node", nodeId: id }); }}`, the same `submit` every gesture uses. | `d1-delete-on-canvas.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-one-move/moves.ts` is `dropToMoveOp` cut down to its decision with one bug from the chapter planted in it. Read the failing assertion, say how many ops one drop sent and what the node's id did, then fix it in that file. The fix turns two ops into one. | `d2-one-move/moves.drill.test.ts` passes |
| D3 · fix a planted bug | `d3-world-cursor/cursor.ts` is the surface's pointer send and cursor draw cut down to their decision with one bug planted. Read the failing assertion, say in which coordinate system the cursor was sent and which the other window expected, then fix it. The fix is one call. | `d3-world-cursor/cursor.drill.test.ts` passes |
| D4 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too (the registry's
own test refuses two rows one keydown could mean, and the e2e specs press keys on the canvas). None of the drills needs
Docker or the dev database: D1 reads files, D2 and D3 are pure.

Stuck on D2? Section 4 of the chapter ("The layers tree: a drop is one move_node") and `dropToMoveOp` in
`apps/web/src/layer-moves.ts`. A move is one of the four ops (SPEC keystone 3); a remove followed by an add is two
round trips, two journal rows, a moment in which the node does not exist for anyone, and a NEW node id, so the other
person's selection of it, the AI's anchor on it and the audit trail's story of it are all broken. The index is the
node's FINAL place counted after it was taken out: filter the node out of its new siblings before you count.

Stuck on D3? Section 7 ("Presence in world coordinates"). The other window has its own size, zoom and pan, so a
screen pixel of yours names nothing there; only a point on the sheet (the frame's own px at 100 %) is the same
component in both. `toWorld(viewport, screenPoint)` is the inverse of `toScreen`; the draw side already expects world.

Stuck on D1's type checker? `ActionOf<"canvas">` is derived from the table, so once the row exists the `switch` in
Surface.tsx may name `"remove"`, and not before. `ROOT_ID` (from `@noon/doc-model`) is the page; the surface knows
`selected`, so it can decline to ask for the page's removal instead of sending an op the replica will refuse.
