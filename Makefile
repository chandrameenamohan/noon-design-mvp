# The gate. `make check` is the only judge of done; each layer is also runnable alone.
.PHONY: check lint typecheck unit integration deadcode dup e2e e2e-scenario
check: lint typecheck unit integration deadcode dup e2e

lint:      ; pnpm exec eslint . --max-warnings 0
typecheck: ; pnpm exec tsc --noEmit
unit:      ; pnpm exec vitest run
integration: ; pnpm exec vitest run --config vitest.integration.config.ts
deadcode:  ; pnpm exec knip
dup:       ; pnpm exec jscpd .
e2e:       ; pnpm exec playwright test
# e2e:spec-scenario: the browser half of SPEC §8, on two sync nodes, one of which it kills (outside `make e2e`).
e2e-scenario: ; pnpm exec playwright test --config playwright.scenario.config.ts

# The reconcile simulator (SPEC F8a). Its committed seeds also run inside `make check`, as unit tests
# (apps/sync/src/sim.test.ts); this target is for a person: `make sim`, or one seed with its trace:
#   node apps/sync/src/sim-cli.ts --seed 7 --trace
.PHONY: sim
sim: ; node apps/sync/src/sim-cli.ts

# Outside `make check`: proves every lesson's exercises and drills behave as their chapter says.
.PHONY: drills
drills: ; sh drills/lesson-0/check.sh && sh drills/lesson-1/check.sh && sh drills/lesson-2/check.sh && sh drills/lesson-3/check.sh && sh drills/lesson-4/check.sh && sh drills/lesson-5/check.sh && sh drills/lesson-6/check.sh && sh drills/lesson-7/check.sh && sh drills/lesson-8/check.sh && sh drills/lesson-9/check.sh && sh drills/lesson-10/check.sh

# Outside `make check`: the chaos checks (SPEC §4a) break the REAL compose stack (./init.sh first) and prove
# the system's guarantees hold. Each prints one JSON line and exits non-zero on FAIL.
.PHONY: chaos
chaos: ; node scripts/chaos/postgres-down-read-only.ts && node scripts/chaos/kill-sync-no-loss.ts && node scripts/chaos/kill-owner-failover.ts && node scripts/chaos/fenced.ts zombie && node scripts/chaos/fenced.ts partition && node scripts/chaos/kill-worker-resumes.ts && node scripts/chaos/redis-wipe-rebuild.ts

# Outside `make check` (minutes, builds an image): F1 on a fresh clone of the committed HEAD.
.PHONY: clean-clone
clean-clone: ; sh scripts/clean-clone.sh

# Outside `make check` (the longest run there is): SPEC §8 end to end on a fresh clone, two sync nodes, `make chaos` included.
.PHONY: scenario
scenario: ; sh scripts/clean-clone.sh sh scripts/spec-scenario.sh

# The sandbox image (E4.2a): the sample app's dev server with node_modules baked in. Minutes the first
# time, cached after. The sandbox integration test builds it too, so `make check` never runs a stale one.
.PHONY: sandbox-image
sandbox-image: ; docker build --tag noon-sandbox:dev --file apps/worker/sandbox/Dockerfile seed/sample-app

# Regenerates the component manifest from the sample app's types. `make check` fails when it is stale.
.PHONY: manifest
manifest: ; pnpm --filter @noon/design-system generate

# check:catalog-complete (Z.2a, SPEC §4a A0): every property in antithesis/scratchbook/ has a type, priority, assertion
# site, evidence and, for an always, its sometimes vacuity guard. Also runs inside `make check` as a unit test.
.PHONY: catalog-check
catalog-check: ; node scripts/catalog-check.ts

# Z.2b (SPEC §4a A1): the local Antithesis-style harness, deploy/antithesis/. Outside `make check` (it builds two
# images and breaks a running slice for minutes). Its own compose project, no published port: the dev stack is not touched.
#   harness-baseline-all-pass   `run.sh up` then `baseline`: every property of the catalog PASS
#   harness-vacuity-guards-hit  the same baseline's report: every vacuity guard fired (runs a baseline if there is none)
#   harness-no-internet         no route out of any container, no published port, no model credential
.PHONY: harness-baseline-all-pass harness-vacuity-guards-hit harness-no-internet
harness-baseline-all-pass: ; deploy/antithesis/run.sh up && deploy/antithesis/run.sh baseline && deploy/antithesis/run.sh report --require pass
harness-vacuity-guards-hit: ; deploy/antithesis/run.sh report --require guards || { deploy/antithesis/run.sh up && deploy/antithesis/run.sh baseline; deploy/antithesis/run.sh report --require guards; }
harness-no-internet: ; deploy/antithesis/run.sh up && deploy/antithesis/run.sh no-internet
