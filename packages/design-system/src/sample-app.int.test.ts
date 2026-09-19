import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

// The sample app is the "customer repo": it is NOT part of this workspace (the sandbox will clone
// it and install it by itself), so it is proven the way a customer's CI would prove it.
const run = promisify(execFile);
const APP = new URL("../../../seed/sample-app/", import.meta.url).pathname;
const pnpm = (...args: string[]) => run("pnpm", ["--ignore-workspace", ...args], { cwd: APP, timeout: 170_000 });

test("the sample app installs from its own lockfile, type-checks, renders all six components, and builds", async () => {
  await pnpm("install", "--frozen-lockfile");
  await pnpm("exec", "tsc", "--noEmit");
  const rendered = await pnpm("test");
  expect(rendered.stdout).toMatch(/1 passed/);
  await pnpm("build");
}, 180_000);
