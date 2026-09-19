import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { CreateDocumentBody, CreateOrgBody, CreateWorkspaceBody, type ErrorBody, type HealthResponse } from "@noon/contracts";
import type { Db } from "@noon/db";

const notFound = (c: Context) => c.json({ error: "not_found" } satisfies ErrorBody, 404);

/**
 * Reads and validates a JSON body against a contract. On failure it throws a ready-made 400, so a
 * handler's happy path stays one straight line and cannot forget to validate.
 */
async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { res: c.json({ error: "invalid_json" } satisfies ErrorBody, 400) });
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.flatMap((issue) =>
    // An unknown key is reported on the parent with the offending names in `keys`.
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ field: key, message: "unknown field" }))
      : [{ field: issue.path.join("."), message: issue.message }],
  );
  throw new HTTPException(400, { res: c.json({ error: "invalid_body", issues } satisfies ErrorBody, 400) });
}

/** Builds the HTTP app. Pure: no port is opened here, and the database arrives as an argument. */
export function buildApp({ db }: { db: Db }): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "api" } satisfies HealthResponse));

  app.post("/orgs", async (c) => c.json(await db.createOrg(await body(c, CreateOrgBody)), 201));
  app.get("/orgs/:orgId", async (c) => {
    const org = await db.getOrg(c.req.param("orgId"));
    return org ? c.json(org) : notFound(c);
  });

  // Everything below belongs to one org. The scope is created once per request from the path, and
  // an org that does not exist is a 404 before any tenant query runs.
  const org = new Hono<{ Variables: { scope: ReturnType<Db["forOrg"]> } }>();
  org.use(async (c, next) => {
    const orgId = c.req.param("orgId") ?? "";
    if (!(await db.getOrg(orgId))) return notFound(c);
    c.set("scope", db.forOrg(orgId));
    await next();
  });

  org.post("/workspaces", async (c) => c.json(await c.var.scope.createWorkspace(await body(c, CreateWorkspaceBody)), 201));
  org.get("/workspaces", async (c) => c.json(await c.var.scope.listWorkspaces()));
  org.get("/workspaces/:id", async (c) => {
    const ws = await c.var.scope.getWorkspace(c.req.param("id"));
    return ws ? c.json(ws) : notFound(c);
  });

  org.post("/workspaces/:id/documents", async (c) => {
    const { title } = await body(c, CreateDocumentBody);
    const doc = await c.var.scope.createDocument({ workspaceId: c.req.param("id"), title });
    return doc ? c.json(doc, 201) : notFound(c);
  });
  org.get("/workspaces/:id/documents", async (c) => {
    const id = c.req.param("id");
    return (await c.var.scope.getWorkspace(id)) ? c.json(await c.var.scope.listDocuments(id)) : notFound(c);
  });
  org.get("/documents/:id", async (c) => {
    const doc = await c.var.scope.getDocument(c.req.param("id"));
    return doc ? c.json(doc) : notFound(c);
  });

  app.route("/orgs/:orgId", org);

  app.notFound(notFound);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // Database errors echo input, table and constraint names. The client gets none of it.
    process.stderr.write(`api: ${c.req.method} ${c.req.path} failed: ${err.message}\n`);
    return c.json({ error: "internal" } satisfies ErrorBody, 500);
  });

  return app;
}
