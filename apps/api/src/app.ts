import { Hono } from "hono";
import type { HealthResponse } from "@noon/contracts";

/** Builds the HTTP app. Pure: no port, no I/O, so it can be created freely in tests. */
export function buildApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    // `satisfies` checks the literal against the contract's type without widening it.
    const body = { status: "ok", service: "api" } satisfies HealthResponse;
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}
