#!/usr/bin/env bash
# Learning test: Node 24 native TypeScript support (type stripping) in a
# pnpm-workspace monorepo, no build step.
#
# Runs every experiment for the 11 assumptions and prints PASS/FAIL/INFO
# per assumption. This script is meant to be re-run from scratch; it does
# `pnpm install` itself so node_modules symlinks always exist.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
DEMO="$ROOT/apps/demo/src"
TEST="$ROOT/apps/demo/test"

PASS=0
FAIL=0
RESULTS=()

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); RESULTS+=("PASS: $1"); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); RESULTS+=("FAIL: $1"); }
info() { echo "  INFO: $1"; RESULTS+=("INFO: $1"); }

section() { echo; echo "=== $1 ==="; }

echo "Node: $(node --version)"
echo "pnpm: $(pnpm --version)"
echo "cwd:  $ROOT"

section "setup: pnpm install (creates the workspace symlinks)"
pnpm install >/tmp/nt-install.log 2>&1
if [ $? -eq 0 ]; then
  pass "pnpm install succeeded using this folder's own pnpm-workspace.yaml"
else
  fail "pnpm install failed; see /tmp/nt-install.log"
  cat /tmp/nt-install.log
fi

# -----------------------------------------------------------------------
section "Assumption 1: node file.ts runs with no flag, check for warnings"
OUT=$(node "$DEMO/a1-no-flag.ts" 2>&1)
CODE=$?
echo "  output: $OUT"
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "a1-ok"; then
  if echo "$OUT" | grep -qi "experimental"; then
    info "ran successfully but printed an experimental warning: $OUT"
  else
    pass "ran with no flag and no experimental warning printed"
  fi
else
  fail "did not run cleanly (exit $CODE): $OUT"
fi

# -----------------------------------------------------------------------
section "Assumption 2: workspace package import through node_modules symlink"
OUT=$(node "$DEMO/a2-workspace-import.ts" 2>&1)
CODE=$?
echo "  output: $OUT"
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "a2-ok"; then
  pass "importing @nt/lib (exports -> ./src/index.ts) through the symlink works by default"
else
  fail "importing @nt/lib through the symlink FAILED (exit $CODE): $OUT"
fi

echo "  --- same import, but with --preserve-symlinks ---"
OUT2=$(node --preserve-symlinks "$DEMO/a2-workspace-import.ts" 2>&1)
CODE2=$?
echo "  output: $OUT2"
if [ $CODE2 -eq 0 ]; then
  info "--preserve-symlinks: still works (exit 0): $OUT2"
else
  info "--preserve-symlinks: BREAKS it (exit $CODE2): $OUT2"
fi

# -----------------------------------------------------------------------
section "Assumption 3: relative imports must include the .ts extension"
OUT=$(node "$DEMO/a3-ext-required.ts" 2>&1)
CODE=$?
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "a3-with-ts-ext-ok"; then
  pass "explicit .ts extension works: $OUT"
else
  fail "explicit .ts extension unexpectedly failed (exit $CODE): $OUT"
fi

# Not just "did it fail" -- it must fail for the SPECIFIC reason expected
# (ERR_MODULE_NOT_FOUND resolving the extensionless specifier "helper", not
# e.g. helper.js), or an unrelated failure would be scored as a PASS.
OUT=$(node "$DEMO/a3-ext-none.ts" 2>&1)
CODE=$?
if [ $CODE -ne 0 ] && echo "$OUT" | grep -q "ERR_MODULE_NOT_FOUND" && echo "$OUT" | grep -qE "Cannot find module '[^']*/helper'"; then
  pass "extensionless import correctly FAILS at runtime with ERR_MODULE_NOT_FOUND for 'helper' (exit $CODE)"
  echo "  exact error: $(echo "$OUT" | grep -m1 -E 'Error|Cannot')"
else
  fail "extensionless import did not fail with the expected ERR_MODULE_NOT_FOUND for 'helper' (exit $CODE): $OUT"
fi

OUT=$(node "$DEMO/a3-ext-js.ts" 2>&1)
CODE=$?
if [ $CODE -ne 0 ] && echo "$OUT" | grep -q "ERR_MODULE_NOT_FOUND" && echo "$OUT" | grep -qE "Cannot find module '[^']*/helper\.js'"; then
  pass ".js-suffixed import of a .ts file correctly FAILS at runtime with ERR_MODULE_NOT_FOUND for 'helper.js' (exit $CODE)"
  echo "  exact error: $(echo "$OUT" | grep -m1 -E 'Error|Cannot')"
else
  fail ".js-suffixed import of a .ts file did not fail with the expected ERR_MODULE_NOT_FOUND for 'helper.js' (exit $CODE): $OUT"
fi

# -----------------------------------------------------------------------
section "Assumption 4: non-erasable syntax fails under plain stripping"
# Each construct fails a DIFFERENT way; match the specific code/text Node
# actually prints for that construct so a coincidental unrelated failure
# (wrong file, crash for some other reason) isn't scored as a PASS.
for f in a4-enum a4-namespace a4-param-props a4-decorator; do
  OUT=$(node "$DEMO/$f.ts" 2>&1)
  CODE=$?
  EXPECT_CODE=""
  EXPECT_TEXT=""
  case "$f" in
    a4-enum) EXPECT_CODE="ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"; EXPECT_TEXT="TypeScript enum is not supported" ;;
    a4-namespace) EXPECT_CODE="ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"; EXPECT_TEXT="TypeScript namespace declaration is not supported" ;;
    a4-param-props) EXPECT_CODE="ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"; EXPECT_TEXT="TypeScript parameter property is not supported" ;;
    a4-decorator) EXPECT_TEXT="Invalid or unexpected token" ;;
  esac
  FIRSTLINE=$(echo "$OUT" | grep -m1 -E 'Error|SyntaxError|TypeError' )
  MATCH_OK=1
  if [ -n "$EXPECT_CODE" ] && ! echo "$OUT" | grep -q "$EXPECT_CODE"; then MATCH_OK=0; fi
  if [ -n "$EXPECT_TEXT" ] && ! echo "$OUT" | grep -qF "$EXPECT_TEXT"; then MATCH_OK=0; fi
  if [ $CODE -ne 0 ] && [ $MATCH_OK -eq 1 ]; then
    pass "$f.ts correctly FAILS under plain stripping with expected error (${EXPECT_CODE:-$EXPECT_TEXT}) (exit $CODE)"
    echo "  exact error: $FIRSTLINE"
  else
    fail "$f.ts did not fail with the expected error (${EXPECT_CODE:-$EXPECT_TEXT}) (exit $CODE): $OUT"
  fi
done

echo "  --- same enum, but with --experimental-transform-types ---"
OUT=$(node --experimental-transform-types "$DEMO/a4-enum-transform.ts" 2>&1)
CODE=$?
echo "  output/err: $OUT"
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "a4-enum-transform"; then
  info "--experimental-transform-types DOES make enum work (exit 0)"
else
  info "--experimental-transform-types did NOT make enum work (exit $CODE): $OUT"
fi

# -----------------------------------------------------------------------
section "Assumption 5: import type / export type required for type-only imports"
OUT=$(node "$DEMO/a5-import-type-bad.ts" 2>&1)
CODE=$?
if [ $CODE -ne 0 ] && echo "$OUT" | grep -qF "does not provide an export named 'Config'"; then
  pass "importing a type as a value FAILS at runtime with the expected 'does not provide an export named' SyntaxError (exit $CODE)"
  echo "  exact error: $(echo "$OUT" | grep -m1 -E 'Error|SyntaxError')"
else
  fail "importing a type as a value did not fail with the expected error text (exit $CODE): $OUT"
fi

OUT=$(node "$DEMO/a5-import-type-good.ts" 2>&1)
CODE=$?
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "a5-good"; then
  pass "\`import type\` fixes it: $OUT"
else
  fail "\`import type\` version unexpectedly failed (exit $CODE): $OUT"
fi

echo "  --- tsc --noEmit with verbatimModuleSyntax should flag a5-import-type-bad.ts ---"
TSC_OUT=$(pnpm exec tsc --noEmit -p "$ROOT/tsconfig.json" 2>&1)
if echo "$TSC_OUT" | grep -q "a5-import-type-bad.ts"; then
  pass "tsc (verbatimModuleSyntax) flags a5-import-type-bad.ts"
  echo "  exact tsc error: $(echo "$TSC_OUT" | grep -m1 "a5-import-type-bad.ts")"
else
  fail "tsc did NOT flag a5-import-type-bad.ts"
fi

# -----------------------------------------------------------------------
section "Assumption 6: type errors do not stop execution"
OUT=$(node "$DEMO/a6-type-error.ts" 2>&1)
CODE=$?
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "a6-ran-anyway"; then
  pass "file with a blatant type error still RUNS fine under node: $OUT"
else
  fail "file with a type error unexpectedly did not run (exit $CODE): $OUT"
fi

if echo "$TSC_OUT" | grep -q "a6-type-error.ts"; then
  pass "tsc --noEmit DOES catch the type error"
  echo "  exact tsc error: $(echo "$TSC_OUT" | grep -m1 "a6-type-error.ts")"
else
  fail "tsc --noEmit did NOT catch the type error in a6-type-error.ts"
fi

# -----------------------------------------------------------------------
section "Assumption 7: stack trace line/col matches source (no source maps)"
node "$DEMO/a7-check.mjs"
if [ $? -eq 0 ]; then
  pass "see a7-info/a7-PASS line above"
else
  fail "see a7 output above"
fi

# -----------------------------------------------------------------------
section "Assumption 8: tsconfig paths ignored at runtime; package.json imports work"
OUT=$(node "$DEMO/a8-tsconfig-paths.ts" 2>&1)
CODE=$?
if [ $CODE -ne 0 ] && echo "$OUT" | grep -q "ERR_MODULE_NOT_FOUND" && echo "$OUT" | grep -qF "Cannot find package '@app/helper.ts'"; then
  pass "tsconfig 'paths' alias correctly FAILS at runtime with ERR_MODULE_NOT_FOUND for '@app/helper.ts' (exit $CODE)"
  echo "  exact error: $(echo "$OUT" | grep -m1 -E 'Error|Cannot')"
else
  fail "tsconfig 'paths' alias did not fail with the expected ERR_MODULE_NOT_FOUND for '@app/helper.ts' (exit $CODE): $OUT"
fi

OUT=$(node "$DEMO/a8-package-imports.ts" 2>&1)
CODE=$?
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "a8-imports-ok"; then
  pass "package.json 'imports' (#helper) works as the runtime alternative: $OUT"
else
  fail "package.json 'imports' unexpectedly failed (exit $CODE): $OUT"
fi

# -----------------------------------------------------------------------
section "Assumption 9: .tsx cannot be run by Node directly"
OUT=$(node "$DEMO/a9-jsx.tsx" 2>&1)
CODE=$?
if [ $CODE -ne 0 ] && echo "$OUT" | grep -q "ERR_UNKNOWN_FILE_EXTENSION" && echo "$OUT" | grep -qF ".tsx"; then
  pass ".tsx correctly FAILS to run with ERR_UNKNOWN_FILE_EXTENSION (exit $CODE)"
  echo "  exact error: $(echo "$OUT" | grep -m1 -E 'Error|SyntaxError')"
else
  fail ".tsx did not fail with the expected ERR_UNKNOWN_FILE_EXTENSION (exit $CODE): $OUT"
fi

# -----------------------------------------------------------------------
section "Assumption 10: node --watch restarts on change in imported workspace package"

# --- Control: node --watch WITHOUT --watch-path -----------------------
# FINDINGS previously claimed --watch-path "was required" but never ran
# this control. Run it first so we can state the TRUE result.
CONTROL_LOG=$(mktemp)
node --watch "$DEMO/a10-watch.ts" >"$CONTROL_LOG" 2>&1 &
CONTROL_PID=$!
sleep 1.5
sed -i.bak 's/LIB_VERSION = 1/LIB_VERSION = 2/' "$ROOT/packages/lib/src/index.ts"
sleep 1.5
kill $CONTROL_PID 2>/dev/null
wait $CONTROL_PID 2>/dev/null
mv "$ROOT/packages/lib/src/index.ts.bak" "$ROOT/packages/lib/src/index.ts" 2>/dev/null || \
  sed -i.bak2 's/LIB_VERSION = 2/LIB_VERSION = 1/' "$ROOT/packages/lib/src/index.ts" && rm -f "$ROOT/packages/lib/src/index.ts.bak2"
echo "  control watch log (no --watch-path):"
sed 's/^/    /' "$CONTROL_LOG"
CONTROL_V1=$(grep -c "LIB_VERSION=1" "$CONTROL_LOG")
CONTROL_V2=$(grep -c "LIB_VERSION=2" "$CONTROL_LOG")
if [ "$CONTROL_V1" -ge 1 ] && [ "$CONTROL_V2" -ge 1 ]; then
  CONTROL_RESTARTED=1
  info "control: node --watch WITHOUT --watch-path ALSO restarted on the workspace package's .ts change (saw both LIB_VERSION=1 and LIB_VERSION=2) -- --watch-path is NOT required for this scenario"
else
  CONTROL_RESTARTED=0
  info "control: node --watch WITHOUT --watch-path did NOT restart on the workspace package's .ts change (v1 seen $CONTROL_V1 times, v2 seen $CONTROL_V2 times) -- --watch-path appears to be required for this scenario"
fi
rm -f "$CONTROL_LOG"

# --- With --watch-path (the original experiment) -----------------------
WATCH_LOG=$(mktemp)
node --watch --watch-path="$ROOT" "$DEMO/a10-watch.ts" >"$WATCH_LOG" 2>&1 &
WATCH_PID=$!
sleep 1.5
sed -i.bak 's/LIB_VERSION = 1/LIB_VERSION = 2/' "$ROOT/packages/lib/src/index.ts"
sleep 1.5
kill $WATCH_PID 2>/dev/null
wait $WATCH_PID 2>/dev/null
mv "$ROOT/packages/lib/src/index.ts.bak" "$ROOT/packages/lib/src/index.ts" 2>/dev/null || \
  sed -i.bak2 's/LIB_VERSION = 2/LIB_VERSION = 1/' "$ROOT/packages/lib/src/index.ts" && rm -f "$ROOT/packages/lib/src/index.ts.bak2"
echo "  watch log (with --watch-path):"
sed 's/^/    /' "$WATCH_LOG"
V1_COUNT=$(grep -c "LIB_VERSION=1" "$WATCH_LOG")
V2_COUNT=$(grep -c "LIB_VERSION=2" "$WATCH_LOG")
if [ "$V1_COUNT" -ge 1 ] && [ "$V2_COUNT" -ge 1 ]; then
  pass "node --watch --watch-path=<root> restarted after editing the workspace package's .ts file (saw both LIB_VERSION=1 and LIB_VERSION=2)"
else
  fail "node --watch --watch-path=<root> did NOT pick up the change (v1 seen $V1_COUNT times, v2 seen $V2_COUNT times)"
fi
rm -f "$WATCH_LOG"

if [ "$CONTROL_RESTARTED" -eq 1 ]; then
  info "TRUE RESULT for assumption 10: --watch-path was NOT necessary in this scenario -- default node --watch already follows the module graph through the pnpm symlink to the package's realpath. See FINDINGS.md."
else
  info "TRUE RESULT for assumption 10: --watch-path WAS necessary in this scenario -- default node --watch did not pick up the workspace package's change without it. See FINDINGS.md."
fi

# -----------------------------------------------------------------------
section "Assumption 11: node --test discovers *.test.ts natively"
echo "  --- explicit file: node --test apps/demo/test/math.test.ts ---"
OUT=$(node --test "$TEST/math.test.ts" 2>&1)
CODE=$?
echo "$OUT" | tail -15
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "pass 1"; then
  pass "node --test ran math.test.ts (given as an explicit file path) successfully"
else
  fail "node --test did not run math.test.ts as expected (exit $CODE)"
fi

echo "  --- auto-discovery: node --test (cwd=apps/demo, no path arg) ---"
OUT=$(cd "$ROOT/apps/demo" && node --test 2>&1)
CODE=$?
echo "$OUT" | tail -15
if [ $CODE -eq 0 ] && echo "$OUT" | grep -q "pass 1"; then
  pass "node --test auto-discovered test/math.test.ts with no path argument"
else
  fail "node --test auto-discovery did not find math.test.ts as expected (exit $CODE)"
fi

echo "  --- directory as positional arg: node --test apps/demo/test (known NOT to work as 'search this dir') ---"
OUT=$(node --test "$TEST" 2>&1)
CODE=$?
if [ $CODE -ne 0 ] && echo "$OUT" | grep -q "MODULE_NOT_FOUND"; then
  info "passing a directory path directly does NOT search it; node tries to require() it as a module and fails with MODULE_NOT_FOUND"
else
  info "directory-as-positional-arg result (exit $CODE): $(echo "$OUT" | tail -3)"
fi

# -----------------------------------------------------------------------
section "SUMMARY"
echo "PASS=$PASS FAIL=$FAIL"
for r in "${RESULTS[@]}"; do echo "  $r"; done

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "run.sh: $FAIL check(s) FAILED -- exiting non-zero"
  exit 1
fi
exit 0
