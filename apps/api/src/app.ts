import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import {
  CreateDocumentBody,
  CreateOrgBody,
  CreateWorkspaceBody,
  PageQuery,
  type ErrorBody,
  type HealthResponse,
  type Org,
  type User,
} from "@noon/contracts";
import type { Db } from "@noon/db";
import type { Identify } from "./identity.ts";

const MAX_BODY_BYTES = 64 * 1024;

type ErrorCode = ErrorBody["error"];
const fail = (c: Context, status: 400 | 401 | 404 | 413 | 415 | 500 | 503, error: ErrorCode, issues?: ErrorBody["issues"]) =>
  c.json((issues ? { error, issues } : { error }) satisfies ErrorBody, status);
const notFound = (c: Context) => fail(c, 404, "not_found");

/** Turns Zod issues into `{field, message}`. A problem with the value as a whole is named by `root`. */
function issuesOf(error: z.ZodError, root: string): NonNullable<ErrorBody["issues"]> {
  return error.issues.flatMap((issue) =>
    // An unknown key is reported on its PARENT, with the offending names in `keys`.
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ field: [...issue.path, key].join("."), message: "unknown field" }))
      : [{ field: issue.path.join(".") || root, message: issue.message }],
  );
}

/**
 * Reads and validates a JSON body against a contract. On failure it throws a ready-made response,
 * so a handler's happy path stays one straight line and cannot forget to validate.
 */
async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  // Browsers may send text/plain cross-site WITHOUT a preflight. Demanding JSON closes that door
  // before any cookie-based auth exists to be abused through it.
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
    throw new HTTPException(415, { res: fail(c, 415, "unsupported_media_type") });
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { res: fail(c, 400, "invalid_json") });
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new HTTPException(400, { res: fail(c, 400, "invalid_body", issuesOf(parsed.error, "body")) });
}

function pageQuery(c: Context): PageQuery {
  const parsed = PageQuery.safeParse(c.req.query());
  if (parsed.success) return parsed.data;
  throw new HTTPException(400, { res: fail(c, 400, "invalid_query", issuesOf(parsed.error, "query")) });
}
const badCursor = (c: Context) => fail(c, 400, "invalid_query", [{ field: "cursor", message: "not a cursor issued by this server" }]);

/** Builds the HTTP app. Pure: no port is opened here, and the database arrives as an argument. */
export function buildApp({ db, identify }: { db: Db; identify: Identify }): Hono<{ Variables: { user: User } }> {
  const app = new Hono<{ Variables: { user: User } }>();

  app.use(async (c, next) => {
    await next();
    // Tenant data must never sit in a shared cache or be re-interpreted by a browser.
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
  });
  app.use(bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, "payload_too_large") }));

  // Liveness: "this process is up". It must not depend on the database, or a database outage
  // would make the orchestrator kill a process that is otherwise able to report the outage.
  app.get("/health", (c) => c.json({ status: "ok", service: "api" } satisfies HealthResponse));
  // Readiness: "this process can do its job". This is what the container healthcheck asks.
  app.get("/ready", async (c) => {
    try {
      await db.ping();
      return c.json({ status: "ok", service: "api" } satisfies HealthResponse);
    } catch {
      return fail(c, 503, "not_ready");
    }
  });

  // Everything under /orgs needs a caller. The probes above do not.
  // createMiddleware carries the Variables type, so `c.var.user` is typed (not `any`) downstream.
  const requireUser = createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
    const user = await identify(c, db);
    if (!user) return fail(c, 401, "unauthenticated");
    c.set("user", user);
    await next();
  });
  app.use("/orgs/*", requireUser);

  app.post("/orgs", async (c) => {
    const { name } = await body(c, CreateOrgBody);
    return c.json(await db.createOrg({ name, ownerId: c.var.user.id }), 201);
  });
  app.get("/orgs", async (c) => {
    const page = await db.listOrgsFor(c.var.user.id, pageQuery(c));
    return page ? c.json(page) : badCursor(c);
  });

  // EVERYTHING about one org lives behind this middleware, including reading the org itself: it is
  // the one place that decides whether the caller may see this org. Not a member and no such org
  // are the same answer, 404, so a response never confirms that someone else's org exists (F2).
  const org = new Hono<{ Variables: { user: User; org: Org; scope: ReturnType<Db["forOrg"]> } }>();
  org.use(async (c, next) => {
    const found = await db.getOrgForMember(c.req.param("orgId") ?? "", c.var.user.id);
    if (!found) return notFound(c);
    c.set("org", found);
    c.set("scope", db.forOrg(found.id));
    await next();
  });

  org.get("/", (c) => c.json(c.var.org));

  org.post("/workspaces", async (c) => c.json(await c.var.scope.createWorkspace(await body(c, CreateWorkspaceBody)), 201));
  org.get("/workspaces", async (c) => {
    const page = await c.var.scope.listWorkspaces(pageQuery(c));
    return page ? c.json(page) : badCursor(c);
  });
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
    const query = pageQuery(c);
    if (!(await c.var.scope.getWorkspace(id))) return notFound(c);
    const page = await c.var.scope.listDocuments(id, query);
    return page ? c.json(page) : badCursor(c);
  });
  org.get("/documents/:id", async (c) => {
    const doc = await c.var.scope.getDocument(c.req.param("id"));
    return doc ? c.json(doc) : notFound(c);
  });

  app.route("/orgs/:orgId", org);

  app.notFound(notFound);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // Database errors echo input, table and constraint names: the client gets none of it. The log is
    // one JSON object per line, so a newline inside a message cannot forge a second log entry.
    process.stderr.write(`${JSON.stringify({ level: "error", method: c.req.method, path: c.req.path, message: err.message })}\n`);
    return fail(c, 500, "internal");
  });

  return app;
}
