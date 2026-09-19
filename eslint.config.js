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
  {
    // check:single-write-path (SPEC keystone 2). Ops reach a document through @noon/peer-client and
    // nothing else: a second sender would have its own idea of baseSeq, resends and rollback.
    // Flat config REPLACES a rule's options instead of merging them, so the block above is repeated here.
    ignores: ["packages/peer-client/**", "apps/sync/**", "packages/contracts/**", "**/*.test.ts", "**/testing.ts"], // tests may PARSE the wire contract; e2e specs are not exempt
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["**/testing.ts", "**/testing"], message: "Test-only raw-SQL helper: import it from *.int.test.ts files only." }],
        paths: [
          { name: "@noon/contracts", importNames: ["ClientOp", "ClientMessage"], message: "Only @noon/peer-client sends ops: call peer.submit(op)." },
          { name: "ws", message: "Only @noon/peer-client talks to the sync service: use connectPeer()." },
        ],
      }],
      "no-restricted-globals": ["error", { name: "WebSocket", message: "Only @noon/peer-client talks to the sync service: use connectPeer()." }],
      // The same global by its other names: what isomorphic browser/Node code tends to write.
      "no-restricted-properties": ["error", ...["globalThis", "window", "self"].map((object) => ({ object, property: "WebSocket", message: "Only @noon/peer-client talks to the sync service: use connectPeer()." }))],
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
