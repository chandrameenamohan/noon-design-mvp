#!/bin/sh
# SPEC §8 (Z.1), the steps after the first, in a checkout whose stack ./init.sh has started. `make scenario` runs it
# in a CLEAN clone of the committed HEAD, after step 1 (./init.sh, `make check`): scripts/clean-clone.sh.
# The browser steps are one Playwright spec on two sync nodes (e2e/spec-scenario.spec.ts); the rest are shell.
# No `set -e`: every step says which one failed.
set -u
cd "$(dirname "$0")/.." || exit 1
fail() { echo "FAIL: SPEC §8 step $1"; exit 1; }

# 3: the reconcile simulator.
make -s sim || fail "3 (make sim)"
# 2 to 7, 9 and 10: sign-up, roles and shares, two browsers and a viewer, the preview, the AI, git, a sync node killed
# under the room, Ship twice, the revoke and the audit trail.
make -s e2e-scenario || fail "2-7, 9, 10 (e2e:spec-scenario)"
# 7 and 8 against the compose stack: a node killed, one paused past its lease, one cut off Redis; the worker killed mid-run.
API_URL="http://localhost:${API_PORT:-3000}" make -s chaos || fail "7, 8 (make chaos)"

# 11: a sample-app prop changed without regenerating the manifest fails the gate's unit layer, naming the component.
button=seed/sample-app/src/design-system/Button.tsx
sed -i.orig 's/"primary" | "secondary" | "ghost"/"primary" | "secondary" | "ghost" | "danger"/' "$button"
out=$(pnpm exec vitest run packages/design-system/src/drift.test.ts 2>&1); drifted=$?
mv "$button.orig" "$button"
[ "$drifted" -ne 0 ] || fail "11 (the drift guard passed a changed prop)"
printf '%s' "$out" | grep -q "Button: props changed (variant)" || fail "11 (the drift guard did not name Button)"

# 12: every epic's chapter is published (a row with its page in the handbook's index, and the page built) and its
# drills are red to start with.
for n in 1 2 3 4 5 6 7 8 9 10; do
  grep -q "^| $n | .*https://claude.ai/artifact/" docs/handbook/index.md || fail "12 (lesson $n has no published page)"
  [ -s "docs/handbook/lesson-$n.html" ] || fail "12 (lesson $n's page is not built)"
  sh "drills/lesson-$n/check.sh" --expect-red >/dev/null || fail "12 (a lesson $n drill is not red)"
done
echo "PASS: SPEC §8"
