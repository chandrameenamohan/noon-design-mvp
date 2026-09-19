import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules", "**/dist", "seed", "learning-tests", "drills", "docs", "playwright-report", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { "no-console": "error" },
  },
  {
    // packages/db/src/testing.ts holds a raw-SQL door for proving what the DATABASE refuses.
    // package.json "exports" only guards the "@noon/db" name; a relative path would walk around it.
    ignores: ["**/*.int.test.ts", "**/testing.ts"], // test-only helpers may build on each other
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/testing.ts", "**/testing"], message: "Test-only raw-SQL helper: import it from *.int.test.ts files only." }] }],
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
