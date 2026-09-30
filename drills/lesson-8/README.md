# Lesson 8 drills

Do these alone, before reading the answers in the chapter. Each one starts RED.

    sh drills/lesson-8/check.sh          # shows RED (to do) or GREEN (solved) per drill

| Drill | What you do | Green when |
|---|---|---|
| D1 · extend a type, end to end | The audit trail records sign-ins and nothing about sign-outs. Carry a `signed_out` action from the contract to the row: `AuditAction` gains it (`packages/contracts`), the view's `SENTENCES` Record stops compiling until you write "Signed out." (`apps/web/src/audit.ts`), a new migration (the next free number; 0018 or later) re-creates the CHECK constraint `audit_log_action_check` with the new value, and `endSession` in `packages/db/src/index.ts` deletes the session and writes one audit row per org of the user in ONE statement (a CTE over the deleted row, as `startSession` does). Then extend `apps/api/src/audit.int.test.ts`. | `d1-signed-out.drill.test.ts` passes and `make check` is still green |
| D2 · fix a planted bug | `d2-sign-in/sign-in.ts` is `POST /auth/signin` cut down to its decision (the store, the hash check, the one refusal) with one bug from the chapter planted in it. Read the failing assertion, say what an attacker learns from the answer as it is, then fix it in that file. The fix is two lines. | `d2-sign-in/sign-in.drill.test.ts` passes |
| D3 · explain a decision | Answer the three questions in the chapter's drills section out loud or on paper BEFORE opening the answers. | you decide |

Rules: do not change a drill's test. For D1, `make check` must stay green: the gate applies to you too (the type checker
names the view's Record; the integration test in step 5 is the one that proves the statement against Postgres, so run
`make integration` once Docker is free). Neither drill needs Docker or the dev database: D1 reads files, D2 is pure.

Stuck on D2? Section 1 of the chapter ("Passwords: a slow hash that describes itself, and a sign-in that costs the same
for everyone") and the route in `apps/api/src/app.ts`: `verifyPassword(password, found?.passwordHash ?? (await dummyHash()))`,
then `found && matches`. An early return for an unknown email skips the hash, and the answer arrives tens of
milliseconds sooner than a wrong password's: the response time says which emails have accounts.

Stuck on D1's migration? Postgres names an inline column check `<table>_<column>_check`. The migration is two statements
in one file: `alter table audit_log drop constraint audit_log_action_check;` and `alter table audit_log add constraint
audit_log_action_check check (action in (...))` with the new value in the list. The trigger and the grants are not yours
to touch: they are what makes the table append-only, and the drill's test refuses a migration that goes near them.
