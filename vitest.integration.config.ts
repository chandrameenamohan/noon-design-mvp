import { defineConfig } from "vitest/config";

// Integration layer: real dependencies and real processes. Needs `./init.sh` to have been run.
export default defineConfig({
  test: {
    include: ["packages/**/*.int.test.ts", "apps/**/*.int.test.ts"],
    passWithNoTests: false,
    fileParallelism: false, // ponytail: one file at a time keeps shared stores simple; parallelize per-schema if this gets slow
  },
});
