# Verification

`make check` is the only judge of done. The pre-commit hook (`scripts/pre-commit`,
installed by `./init.sh`) runs it on every commit and blocks on red. Never commit
with `--no-verify`, and never weaken, delete or skip a check to get to green.

## Layers

| Layer | Command | Tool | Catches |
|---|---|---|---|
| lint | `make lint` | ESLint 10 + typescript-eslint (strict, type-aware), zero warnings, `no-console` | unsafe `any`, floating promises, stray logging |
| typecheck | `make typecheck` | `tsc --noEmit`, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | type errors across every package, app and e2e test |
| unit | `make unit` | Vitest; fails if no tests are found | logic in `packages/*` and `apps/*` |
| deadcode | `make deadcode` | knip | unused files, exports and dependencies |
| dup | `make dup` | jscpd, threshold 0 (8 lines / 60 tokens) | copy-pasted blocks |
| e2e | `make e2e` | Playwright (Chromium) against the Vite dev server | real browser behavior |

Every e2e test imports `test` from `e2e/fixtures.ts`, which adds two checks after
the test body: the browser console had no errors or warnings, and axe found no
accessibility violations. Key states also use `toHaveScreenshot`.

## The gate was proven red, layer by layer (2026-09-19)

One agent per layer made the smallest violation in a throwaway worktree.
lint, typecheck, dup and e2e (console error, axe violation, screenshot diff,
wrong heading) went red as they should. Two holes were found and closed:
- **unit:** a "rejects" test broke two rules at once, so deleting one rule
  stayed green. Tests now break one rule per case.
- **deadcode:** knip ignores exports of a package's entry file. All packages
  here are internal, so `includeEntryExports` is on and a dead export fails.
Also learned: Playwright's `getByRole(..., { name })` matches substrings;
use `exact: true`.

## Environment

`./init.sh` installs dependencies, the Playwright browser and the hook, starts
Postgres, and prints `PASS` only after a real query is answered.

## Versions pinned on purpose

TypeScript is held at 6.0.x: typescript-eslint 8 supports `<6.1`, so TypeScript 7
breaks the lint layer. Revisit when typescript-eslint supports 7.

## Deliberately not verified yet

| Not verified | Why | Arrives |
|---|---|---|
| Anything using Postgres from code | no code talks to it yet; `init.sh` only proves it is up | epic 1 |
| Reconcile simulator (`make sim`, F8a) | the room and peer-client do not exist | epic 2 |
| Screenshots on Linux | baselines are per-OS; only `darwin` exists | when CI exists |
| Firefox and WebKit | the frontend exists to drive the backend | not planned |
| Crash, failover and fencing tests | need journal and multi-node | epics 6 and 7 |
| Local Antithesis-style harness (SPEC §4a) | needs the finished system | end of build |
| Test coverage thresholds | a number invites tests written for the number | not planned |
