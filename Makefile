# The gate. `make check` is the only judge of done; each layer is also runnable alone.
.PHONY: check lint typecheck unit deadcode dup e2e
check: lint typecheck unit deadcode dup e2e

lint:      ; pnpm exec eslint . --max-warnings 0
typecheck: ; pnpm exec tsc --noEmit
unit:      ; pnpm exec vitest run
deadcode:  ; pnpm exec knip
dup:       ; pnpm exec jscpd .
e2e:       ; pnpm exec playwright test
