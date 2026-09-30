import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import {
  CreateDocumentBody,
  CreateOrgBody,
  CreateRunBody,
  CreateWorkspaceBody,
  DocumentConflict,
  DocumentShip,
  PageQuery,
  type ErrorBody,
  type HealthResponse,
  type Org,
  type Preview,
  type SessionResponse,
  type User,
} from "@noon/contracts";
import type { Db } from "@noon/db";
import { syncRouter, type Holder } from "@noon/lease";
import { describeError, type JobRef } from "@noon/queue";
import { signSessionToken } from "@noon/session-token";
import type { SessionConfig } from "./config.ts";
import type { Identify } from "./identity.ts";
import { readPush, signatureMatches } from "./webhook.ts";

const MAX_BODY_BYTES = 64 * 1024;
/** Gitea's push body carries the commit list: bigger than anything a person sends, still capped before it is read. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const WEBHOOK_PATH = "/webhooks/gitea";

type ErrorCode = ErrorBody["error"];
const fail = (c: Context, status: 400 | 401 | 404 | 409 | 413 | 415 | 500 | 503, error: ErrorCode, issues?: ErrorBody["issues"]) =>
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
export type AppDeps = {
  db: Db;
  identify: Identify;
  sessions: SessionConfig;
  /** Tells a worker that a job is waiting. A seam, so most api tests need no Redis. */
  enqueue: (ref: JobRef) => Promise<void>;
  /** Which sync node owns a document's room (the lease in Redis, E7.1). Only asked with several nodes; a seam like `enqueue`. */
  owner?: (documentId: string) => Promise<Holder | undefined>;
  /** Which sync nodes beat recently (E7.2): a dead owner's peers are sent to a live node. Asked with `owner`. */
  alive?: (nodeIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /** PREVIEW_PUBLIC_URL: the canvas's public origin, which carries previews as /preview/... (noon-l96). */
  previewOrigin?: string | undefined;
  /** GITEA_WEBHOOK_SECRET. Unset: the webhook is a 404, and the git peer's reconcile alone notices pushes. */
  webhookSecret?: string | undefined;
};

/**
 * The preview as THIS canvas can frame it: the stored loopback address, or, behind one public URL, the
 * same path and query on the public origin (the sandbox serves under that path; the canvas's dev server
 * forwards it unchanged). Never kept anywhere: the row stays the loopback truth.
 */
export function publicPreview(preview: Preview, origin: string | undefined): Preview {
  if (origin === undefined || preview.url === null) return preview;
  const url = new URL(preview.url);
  return { ...preview, url: `${origin}${url.pathname}${url.search}` };
}

export function buildApp({ db, identify, sessions, enqueue, owner = () => Promise.reject(new Error("no lease store")), alive = () => Promise.reject(new Error("no lease store")), previewOrigin, webhookSecret }: AppDeps): Hono<{ Variables: { user: User } }> {
  const app = new Hono<{ Variables: { user: User } }>();
  const route = syncRouter({ nodes: sessions.sync, owner, alive });

  app.use(async (c, next) => {
    await next();
    // Tenant data must never sit in a shared cache or be re-interpreted by a browser.
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
  });
  // Both limits refuse by Content-Length before a byte is read, and count the bytes of a body sent without one.
  const smallBodies = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, "payload_too_large") });
  const webhookBodies = bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => fail(c, 413, "payload_too_large") });
  app.use((c, next) => (c.req.path === WEBHOOK_PATH ? webhookBodies : smallBodies)(c, next));

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
  // Identity fails CLOSED: every route needs a caller unless it is listed here. A new top-level
  // route (E1.5's POST /documents/:id/session, for one) is protected without anyone remembering to.
  // createMiddleware carries the Variables type, so `c.var.user` is typed (not `any`) downstream.
  const PUBLIC_PATHS = new Set(["/health", "/ready", WEBHOOK_PATH]);
  const requireUser = createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const user = await identify(c, db);
    if (!user) return fail(c, 401, "unauthenticated");
    c.set("user", user);
    await next();
  });
  app.use("*", requireUser);

  // E5.3a: Gitea's push webhook, public (Gitea has no user to send). The HMAC over the RAW bytes is the only
  // authentication, and nothing in the body is read before it passes. One push is one row: the delivery id
  // and (branch, commit) are both unique keys in Postgres, so a redelivery, a replay and a reconcile that got
  // there first all end as `duplicate`. The git peer does the work; this answers Gitea within its 5 s.
  app.post(WEBHOOK_PATH, async (c) => {
    if (webhookSecret === undefined) return notFound(c);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!signatureMatches(raw, c.req.header("x-gitea-signature"), webhookSecret)) return fail(c, 401, "unauthenticated");
    // Not covered by the signature: a replayed body under a made-up id still meets the (branch, commit) key.
    const delivery = c.req.header("x-gitea-delivery");
    if (delivery === undefined || !/^[\x21-\x7e]{1,100}$/.test(delivery)) return fail(c, 400, "invalid_body", [{ field: "x-gitea-delivery", message: "required: 1 to 100 printable characters" }]);
    if (c.req.header("x-gitea-event") !== "push") return c.json({ result: "ignored", reason: "not_a_push" });
    const push = readPush(raw);
    if (push.kind === "invalid") return fail(c, 400, push.error);
    if (push.kind === "ignored") return c.json({ result: "ignored", reason: push.reason });
    const recorded = await db.gitStore().record({ ref: push.ref, before: push.before, after: push.after, deliveryId: delivery });
    return recorded ? c.json({ result: "recorded" }, 202) : c.json({ result: "duplicate" });
  });

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
  // MEMBERSHIP ONLY: the member's role is ignored here, so today a viewer may create workspaces and
  // documents. Role enforcement arrives in E8.2, which must cover these REST writes, not only ops.
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

  // F12: what this org's AI runs have consumed. Behind the org middleware like everything else about an
  // org, so another org's usage is the usual 404. ponytail: totals over all time; periods and limits are E9.5.
  org.get("/usage", async (c) => {
    const report = await c.var.scope.usage(pageQuery(c));
    return report ? c.json(report) : badCursor(c);
  });

  app.route("/orgs/:orgId", org);

  // The routing hook (SPEC §2.11): a peer never knows a sync address in advance, it asks here, and gets the
  // node that owns the room (E7.1), or any node when nobody does yet. The path names no org, so the lookup
  // itself is membership-filtered.
  app.post("/documents/:id/session", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    if (!doc) return notFound(c);
    // E5.3a: a document is opening, so the git peer looks at Gitea now: a push whose delivery was lost reaches
    // the canvas at once, not on the next timer. Best effort: a session is never refused over it.
    await db.gitStore().requestReconcile().catch((err: unknown) => {
      process.stderr.write(`${JSON.stringify({ level: "warn", path: c.req.path, message: `reconcile not requested: ${describeError(err)}` })}\n`);
    });
    let wsUrl;
    try {
      wsUrl = await route(doc.id);
    } catch (err) {
      // Redis cannot say who owns the room, and no node would open it without knowing: "try again".
      process.stderr.write(`${JSON.stringify({ level: "warn", path: c.req.path, message: `no sync node: ${describeError(err)}` })}\n`);
      return fail(c, 503, "sync_unavailable");
    }
    const now = Math.floor(Date.now() / 1000);
    const token = signSessionToken({ userId: c.var.user.id, name: c.var.user.name, orgId: doc.orgId, documentId: doc.id, secret: sessions.secret, ttlSeconds: sessions.ttlSeconds, now });
    return c.json({
      wsUrl,
      token,
      expiresAt: new Date((now + sessions.ttlSeconds) * 1000).toISOString(),
    } satisfies SessionResponse);
  });

  // MEMBERSHIP ONLY, like the org routes above: a viewer can start a run until E8.2 enforces roles here too.
  // An AI run (F9) is a job: the row in Postgres IS the run; the queue only tells a worker to look.
  app.post("/documents/:id/runs", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    if (!doc) return notFound(c);
    const { instruction } = await body(c, CreateRunBody);
    const run = await db.forOrg(doc.orgId).createRun({ documentId: doc.id, instruction, createdBy: c.var.user.id });
    if (!run) return notFound(c); // the document was deleted in between
    if (run === "busy") return fail(c, 409, "run_in_progress");
    try {
      await enqueue({ queue: "ai", jobId: run.id, orgId: run.orgId });
    } catch (err) {
      // Still a 201: the run exists and the worker's sweep will pick it up. Failing the request would
      // invite a retry, and a second run (idempotency keys are E9).
      process.stderr.write(`${JSON.stringify({ level: "warn", path: c.req.path, message: `enqueue failed, left to the sweep: ${describeError(err)}` })}\n`);
    }
    return c.json(run, 201);
  });
  app.post("/documents/:id/runs/:runId/cancel", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    const run = doc && (await db.forOrg(doc.orgId).cancelRun(doc.id, c.req.param("runId")));
    return run ? c.json(run) : notFound(c);
  });
  app.get("/documents/:id/runs/:runId", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    const run = doc && (await db.forOrg(doc.orgId).getRun(doc.id, c.req.param("runId")));
    return run ? c.json(run) : notFound(c);
  });

  // F15: the document's running page. The canvas POSTs to make sure a preview is on its way and GETs,
  // once a second, where it answers: the address can change when a sandbox restarts, so it is never kept.
  // MEMBERSHIP ONLY, like runs. The job row IS the preview; the queue only tells a worker to look.
  app.post("/documents/:id/preview", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    const opened = doc && (await db.forOrg(doc.orgId).openPreview({ documentId: doc.id, createdBy: c.var.user.id }));
    if (!opened) return notFound(c);
    if (opened === "busy") return fail(c, 409, "preview_limit");
    if (opened.created) {
      // Left to the sweep if Redis is away, as a run is: the job exists, and it will be found.
      await enqueue(opened.created).catch((err: unknown) => {
        process.stderr.write(`${JSON.stringify({ level: "warn", path: c.req.path, message: `enqueue failed, left to the sweep: ${describeError(err)}` })}\n`);
      });
    }
    return c.json(publicPreview(opened.preview, previewOrigin), opened.created ? 201 : 200);
  });
  app.get("/documents/:id/preview", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    const preview = doc && (await db.forOrg(doc.orgId).getPreview(doc.id));
    return preview ? c.json(publicPreview(preview, previewOrigin)) : notFound(c);
  });
  // F16b: the newest push to the document's branch that changed nothing, which the canvas shows as a banner.
  // MEMBERSHIP ONLY, like the preview. The body is parsed with the contract: commit and file are an engineer's text.
  app.get("/documents/:id/conflict", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    const conflict = doc && (await db.forOrg(doc.orgId).getConflict(doc.id));
    return conflict === undefined ? notFound(c) : c.json(DocumentConflict.parse({ conflict }));
  });

  // F17: Ship. A job, like a run: the row IS the ship, the queue only tells the ship worker (which alone holds the
  // Gitea token) to look. Presses coalesce into the ship still waiting (201 when this press made it, 200 when it
  // joined it), so a double click or two tabs never make two; a press while one runs queues the next, which reads
  // the document afresh. MEMBERSHIP ONLY, like runs, until E8.2.
  app.post("/documents/:id/ship", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    const started = doc && (await db.forOrg(doc.orgId).startShip({ documentId: doc.id, createdBy: c.var.user.id }));
    if (!started) return notFound(c);
    if (started.created) {
      // Left to the sweep if Redis is away, as a run is: the job exists, and it will be found.
      await enqueue(started.created).catch((err: unknown) => {
        process.stderr.write(`${JSON.stringify({ level: "warn", path: c.req.path, message: `enqueue failed, left to the sweep: ${describeError(err)}` })}\n`);
      });
    }
    return c.json(started.ship, started.created ? 201 : 200);
  });
  app.get("/documents/:id/ship", async (c) => {
    const doc = await db.getDocumentForMember(c.req.param("id"), c.var.user.id);
    const ship = doc && (await db.forOrg(doc.orgId).getShip(doc.id));
    return ship === undefined ? notFound(c) : c.json(DocumentShip.parse({ ship }));
  });

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
