# The gate. `make check` is the only judge of done; each layer is also runnable alone.
.PHONY: check lint typecheck unit integration deadcode dup e2e
check: lint typecheck unit integration deadcode dup e2e

lint:      ; pnpm exec eslint . --max-warnings 0
typecheck: ; pnpm exec tsc --noEmit
unit:      ; pnpm exec vitest run
integration: ; pnpm exec vitest run --config vitest.integration.config.ts
deadcode:  ; pnpm exec knip
dup:       ; pnpm exec jscpd .
e2e:       ; pnpm exec playwright test

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

# The sandbox image (E4.2a): the sample app's dev server with node_modules baked in. Minutes the first
# time, cached after. The sandbox integration test builds it too, so `make check` never runs a stale one.
.PHONY: sandbox-image
sandbox-image: ; docker build --tag noon-sandbox:dev --file apps/worker/sandbox/Dockerfile seed/sample-app

# Regenerates the component manifest from the sample app's types. `make check` fails when it is stale.
.PHONY: manifest
manifest: ; pnpm --filter @noon/design-system generate
