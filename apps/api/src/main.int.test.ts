import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { TEST_DATABASE_URL } from "../../../packages/db/src/testing.ts";

// The REAL entry point in a REAL process. The other tests hand an identity strategy to startServer
// themselves, so they would stay green if main.ts wired the wrong one. This one would not.
const MAIN = new URL("./main.ts", import.meta.url).pathname;
let child: ChildProcess | undefined;
afterEach(() => child?.kill("SIGKILL"));

async function boot(env: Record<string, string>): Promise<{ url: string; stderr: () => string }> {
  const port = String(20000 + Math.floor(Math.random() * 20000));
  let stderr = "";
  // A clean environment: nothing from the test runner (such as NODE_ENV=test) leaks into the child.
  child = spawn(process.execPath, [MAIN], { env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: TEST_DATABASE_URL, PORT: port, ...env } });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stderr: () => stderr };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`api did not start: ${stderr}`);
}

test.each([["unset", {}], ["production", { NODE_ENV: "production" }], ["test", { NODE_ENV: "test" }]])(
  "with NODE_ENV %s the running api refuses the dev header",
  async (_label, env) => {
    const api = await boot(env);
    const res = await fetch(`${api.url}/orgs`, { headers: { "x-dev-user": "ann@example.com" } });
    expect(res.status).toBe(401);
    expect(api.stderr()).not.toMatch(/DEV IDENTITY/);
  },
);

test("with NODE_ENV=development the header works, and the process says so loudly", async () => {
  const api = await boot({ NODE_ENV: "development" });
  const res = await fetch(`${api.url}/orgs`, { headers: { "x-dev-user": "main-int-test@example.com" } });
  expect(res.status).toBe(200);
  expect(api.stderr()).toMatch(/DEV IDENTITY/);
});
