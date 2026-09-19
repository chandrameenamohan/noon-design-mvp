import { afterAll, beforeAll, expect, test } from "vitest";
import { HealthResponse } from "@noon/contracts";
import type { Db } from "@noon/db";
import { noIdentity } from "./identity.ts";
import { startServer, type RunningServer } from "./server.ts";
import { TEST_SESSIONS } from "./testing.ts";

// A real listening server and a real HTTP request: this is what init.sh's smoke test does too.
let server: RunningServer;
beforeAll(async () => {
  // /health must answer without touching the database, so it gets one that cannot be used.
  server = await startServer({ port: 0, db: {} as Db, identify: noIdentity, sessions: TEST_SESSIONS }); // port 0 = "any free port", so tests never collide
});
afterAll(() => server.close());

test("GET /health answers with a body that satisfies the HealthResponse contract", async () => {
  const res = await fetch(`${server.url}/health`);
  expect(res.status).toBe(200);
  expect(HealthResponse.parse(await res.json())).toEqual({ status: "ok", service: "api" });
});

test("an unknown route without a caller is a JSON 401: identity fails closed, and never as an HTML page", async () => {
  const res = await fetch(`${server.url}/nope`);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthenticated" });
});
