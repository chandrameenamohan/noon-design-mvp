import { afterAll, beforeAll, expect, test } from "vitest";
import { HealthResponse } from "@noon/contracts";
import { startServer, type RunningServer } from "./server.ts";

// A real listening server and a real HTTP request: this is what init.sh's smoke test does too.
let server: RunningServer;
beforeAll(async () => {
  server = await startServer({ port: 0 }); // port 0 = "any free port", so tests never collide
});
afterAll(() => server.close());

test("GET /health answers with a body that satisfies the HealthResponse contract", async () => {
  const res = await fetch(`${server.url}/health`);
  expect(res.status).toBe(200);
  expect(HealthResponse.parse(await res.json())).toEqual({ status: "ok", service: "api" });
});

test("an unknown route is a JSON 404, not an HTML page or a crash", async () => {
  const res = await fetch(`${server.url}/nope`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
