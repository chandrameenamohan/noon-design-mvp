import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

// The REAL entry point in a REAL process: config.test.ts proves loadConfig refuses the key, this
// proves main.ts really calls it before anything else (the rule from E1.4: test the wiring, not the part).
const MAIN = new URL("./main.ts", import.meta.url).pathname;
const env = { PATH: process.env["PATH"] ?? "", DATABASE_URL: "postgres://app:pw@127.0.0.1:1/noon", REDIS_URL: "redis://127.0.0.1:1", SESSION_TOKEN_SECRET: "s".repeat(32), SYNC_URL: "ws://127.0.0.1:1" };

test("the running worker refuses to start with ANTHROPIC_API_KEY set, says why, and never prints the value", () => {
  const child = spawnSync(process.execPath, [MAIN], { env: { ...env, ANTHROPIC_API_KEY: "sk-ant-super-secret" }, encoding: "utf8", timeout: 15_000 });
  expect(child.status).not.toBe(0);
  expect(child.stderr).toMatch(/ANTHROPIC_API_KEY must be unset/);
  expect(child.stdout + child.stderr).not.toContain("super-secret");
  expect(child.stdout).not.toMatch(/draining/);
});
