# Lesson 9 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-9/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend a type, end to end | A run taken over after its worker died looks, on the panel, exactly like a first attempt. Carry the claim count from the row to the screen: `Run` gains a required `attempt` (whole, at least 0) in `packages/contracts`; `RunRow` in `packages/db/src/index.ts` reads the `attempts` column and maps `attempt: r.attempts`; the type checker names every hand-built `Run` (start with `apps/worker/src/run.int.test.ts`); `attemptWords(run)` in `apps/web/src/progress.ts` is `""` for attempt 0 or 1 and a sentence starting "Attempt n" for n >= 2, which `AiPanel.tsx` shows as text. | `d1-retry-shown.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-idempotency-key/keys.ts` is `withKey` cut down to its decision (the store, the claim, the answer from the row) with one bug from the chapter planted in it. Read the failing assertion, say how many jobs twenty presses made and why, then fix it in that file. The fix replaces two calls with one. | `d2-idempotency-key/keys.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too (the type checker
names the fixtures; the integration tests that read runs through RunRow prove the column against Postgres, so run
`make integration` once Docker is free). Neither drill needs Docker or the dev database: D1 reads files, D2 is pure.

Stuck on D2? Section 1 of the chapter ("Idempotency keys: the claim is the row") and `withKey` in `packages/db/src/index.ts`:
`insert into idempotency_keys ... on conflict do nothing`, and only if that inserted nothing, a read of the winner's row.
A look (`find`) and then a write (`put`) are two round trips with an `await` between them, and twenty requests that
arrive together all look before any of them writes: each sees no key, each makes a job. The store's `claim` is the
check and the write in one step, as the unique index makes the insert; use it in place of the two.

Stuck on D1's type checker? `Run` is what `Run.parse` returns in every reader (`readRun`, `readLatestRun`, the panel) and
what `RunRow` produces in the db package, so a required field there is required everywhere a Run is built by hand.
`select *` already returns `attempts` (migration 0019); RunRow's `z.object` must name it or Zod strips it.
