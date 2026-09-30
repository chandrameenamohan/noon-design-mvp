import { expect, test } from "vitest";
import { useApiProcess } from "./testing.ts";

// The REAL entry point in a REAL process. The other tests hand an identity strategy to startServer
// themselves, so they would stay green if main.ts wired the wrong one. This one would not.
const boot = useApiProcess();

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
