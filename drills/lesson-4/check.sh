#!/bin/sh
# Shows each Lesson 4 drill as RED (to do) or GREEN (solved).
#   sh drills/lesson-4/check.sh               your progress; always exits 0
#   sh drills/lesson-4/check.sh --expect-red  used when the lesson ships: fails if a drill is NOT red
cd "$(dirname "$0")/../.." || exit 1
bad=0
for drill in drills/lesson-4/d1-code-route.drill.test.ts drills/lesson-4/d2-reaper/reaper.drill.test.ts; do
  if pnpm exec vitest run --config drills/vitest.config.ts "$drill" >/dev/null 2>&1; then state=GREEN; else state=RED; fi
  echo "$state  $drill"
  [ "$1" = "--expect-red" ] && [ "$state" = "GREEN" ] && bad=1
done
exit $bad
