import { defineConfig } from "vitest/config";

// Unit layer: pure logic, no I/O. Anything named *.int.test.ts belongs to the integration layer.
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
    passWithNoTests: false,
  },
});
