#!/bin/sh
# Proves Lesson 0's exercises: every normal file type-checks and runs; every *.broken.ts
# fails exactly the way its EXPECT header says. Run: sh drills/lesson-0/check.sh
cd "$(dirname "$0")" || exit 1
TSC="pnpm exec tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --erasableSyntaxOnly --allowImportingTsExtensions --module nodenext --target es2024 --types node --skipLibCheck"
fail=0
for f in 0*.ts; do
  case "$f" in
    *.broken.ts)
      want=$(sed -n 's/^\/\/ EXPECT: //p' "$f"); wantrt=$(sed -n 's/^\/\/ EXPECT-RUNTIME: //p' "$f")
      if [ -n "$want" ]; then out=$($TSC "$PWD/$f" 2>&1); else out=$(node "$f" 2>&1); want=$wantrt; fi
      if echo "$out" | grep -q "$want"; then echo "PASS  $f fails with $want"; else echo "FAIL  $f did not fail with $want"; fail=1; fi ;;
    *)
      if $TSC "$PWD/$f" >/dev/null 2>&1 && node "$f" >/dev/null 2>&1; then echo "PASS  $f type-checks and runs"; else echo "FAIL  $f"; fail=1; fi ;;
  esac
done
exit $fail
