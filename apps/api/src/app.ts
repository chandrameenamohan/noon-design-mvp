import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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
  includes,
  PageQuery,
  SetMemberBody,
  ShareBody,
  SignInBody,
  SignUpBody,
  type Document,
  type ErrorBody,
  type HealthResponse,
  type Org,
  type Me,
  type Preview,
  type Role,
  type SessionResponse,
  type User,
} from "@noon/contracts";
import type { Db } from "@noon/db";
import { syncRouter, type Holder } from "@noon/lease";
import { describeError, type JobRef } from "@noon/queue";
import { signSessionToken } from "@noon/session-token";
import { SIGN_IN_TTL_SECONDS, type SessionConfig } from "./config.ts";
import { SESSION_COOKIE, type Identify } from "./identity.ts";
import { dummyHash, hashPassword, hashToken, isSessionToken, newSessionToken, verifyPassword } from "./password.ts";
import { readPush, signatureMatches } from "./webhook.ts";

const MAX_BODY_BYTES = 64 * 1024;
/** Gitea's push body carries the commit list: bigger than anything a person sends, still capped before it is read. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const WEBHOOK_PATH = "/webhooks/gitea";

type ErrorCode = ErrorBody["error"];
const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503, error: ErrorCode, issues?: ErrorBody["issues"]) =>
  c.json((issues ? { error, issues } : { error }) satisfies ErrorBody, status);
const notFound = (c: Context) => fail(c, 404, "not_found");

/** Every guard `need` made, and the role it asks for: how app.test.ts finds a route that declares none. */
export const GUARDS = new WeakMap<object, Role>();
/**
 * E8.2 (F24): the route needs at least `role` in the org (the parent's middleware put the caller's role on the
 * context, from the same row that proved membership). A member without it gets 403: they may see the thing, so
 * "not found" would be a lie; a stranger never gets this far (404, F2). Every org and document route declares one:
 * app.test.ts fails for a route that does not, so a new route is closed until someone decides who may use it.
 */
const need = (role: Role) => {
  const guard = createMiddleware<{ Variables: { role: Role } }>(async (c, next) => {
    if (!includes(c.var.role, role)) return fail(c, 403, "forbidden");
    await next();
  });
  GUARDS.set(guard, role);
  return guard;
};

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
  /** E8.1: how long a sign-in lasts, and whether its cookie is Secure (everywhere but development, which is plain http). */
  signIn?: { ttlSeconds: number; secureCookie: boolean };
  /**
   * E8.1: may this sign-up or sign-in go ahead? `key` names the route and the email. False is 429. The seam for
   * E9.6's limiter. ponytail: allows everything until then; ceiling: an online guesser pays only scrypt's cost per try.
   */
  allowAttempt?: (key: string) => Promise<boolean>;
  /**
   * E8.2 (F24): tells every sync node that this user's role in this org changed, or a share of one of its documents
   * (E8.3), over Redis pub/sub, so their live sessions keep to it within the 10 s F24 allows. A seam like `enqueue`;
   * without Redis in a test, nobody listens.
   */
  accessChanged?: (change: { orgId: string; userId: string }) => Promise<void>;
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

export function buildApp({ db, identify, sessions, enqueue, owner = () => Promise.reject(new Error("no lease store")), alive = () => Promise.reject(new Error("no lease store")), previewOrigin, webhookSecret, signIn = { ttlSeconds: SIGN_IN_TTL_SECONDS, secureCookie: true }, allowAttempt = () => Promise.resolve(true), accessChanged = () => Promise.resolve() }: AppDeps): Hono<{ Variables: { user: User } }> {
  const app = new Hono<{ Variables: { user: User } }>();
  const route = syncRouter({ nodes: sessions.sync, owner, alive });
  // ponytail: announced once, best effort; ceiling: with Redis away here (but not at the sync nodes, which re-read
  // everything when their own link comes back) open sessions keep the old access until the sync nodes' sweep (30 s),
  // or until they reconnect; upgrade: an outbox row the api retries. REST routes, /session and the sync upgrade read
  // the access on every request, so they are never behind.
  const announce = async (c: Context, change: { orgId: string; userId: string }): Promise<void> => {
    await accessChanged(change).catch((err: unknown) => {
      process.stderr.write(`${JSON.stringify({ level: "warn", path: c.req.path, message: `access change not announced: ${describeError(err)}` })}\n`);
    });
  };
  // Paid for now, not by the first sign-in with an unknown email (whose extra hash would be a timing tell).
  dummyHash().catch(() => undefined);

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
  const PUBLIC_PATHS = new Set(["/health", "/ready", WEBHOOK_PATH, "/auth/signup", "/auth/signin", "/auth/signout", "/auth/me"]);
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

  // E8.1 (F23): sign up, sign in, sign out. The session is a cookie the page's script cannot read (HttpOnly)
  // and the browser never sends from another site (SameSite=Strict): that is the CSRF defence for every
  // write, including POST /documents/:id/session, which reads no body and so skips body()'s JSON check.
  const cookieOptions = { httpOnly: true, secure: signIn.secureCookie, sameSite: "Strict", path: "/" } as const;
  async function signedIn(c: Context, user: User, status: 200 | 201) {
    // A new token every time: nothing a browser held before signing in (a planted cookie) becomes a session.
    const { token, hash } = newSessionToken();
    await db.startSession({ userId: user.id, tokenHash: hash, ttlSeconds: signIn.ttlSeconds });
    setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: signIn.ttlSeconds });
    return c.json(user, status);
  }
  // Sign-up must say when an email is taken: without email (a non-goal) there is no way to answer "maybe" and
  // still create the account. That is the one place an account's existence shows, and it is rate limited.
  app.post("/auth/signup", async (c) => {
    const { email, name, password } = await body(c, SignUpBody);
    if (!(await allowAttempt(`signup:${email.toLowerCase()}`))) return fail(c, 429, "too_many_attempts");
    const user = await db.signUp({ email, name, passwordHash: await hashPassword(password) });
    return user === "taken" ? fail(c, 409, "email_taken") : signedIn(c, user, 201);
  });
  // No such email and the wrong password are one answer, in one time: both cost exactly one scrypt.
  app.post("/auth/signin", async (c) => {
    const { email, password } = await body(c, SignInBody);
    if (!(await allowAttempt(`signin:${email.toLowerCase()}`))) return fail(c, 429, "too_many_attempts");
    const found = await db.credentialsFor(email);
    const matches = await verifyPassword(password, found?.passwordHash ?? (await dummyHash()));
    return found && matches ? signedIn(c, found.user, 200) : fail(c, 401, "invalid_credentials");
  });
  // Public, and always 204: signing out twice, or with a cookie that expired, is not an error. The row goes,
  // so a copy of the token (another tab, a stolen cookie) stops working on its very next request.
  app.post("/auth/signout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (isSessionToken(token)) await db.endSession(hashToken(token));
    deleteCookie(c, SESSION_COOKIE, cookieOptions);
    return c.body(null, 204);
  });
  // Public, and 200 either way: a signed-out home page is not an error (a 401 here would be one in every console).
  app.get("/auth/me", async (c) => c.json({ user: (await identify(c, db)) ?? null } satisfies Me));

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
  // The same row carries the caller's role, which each route's `need` checks (E8.2).
  const org = new Hono<{ Variables: { user: User; org: Org; role: Role; scope: ReturnType<Db["forOrg"]> } }>();
  org.use(async (c, next) => {
    const found = await db.getOrgForMember(c.req.param("orgId") ?? "", c.var.user.id);
    if (!found) return notFound(c);
    c.set("org", found.org);
    c.set("role", found.role);
    c.set("scope", db.forOrg(found.org.id));
    await next();
  });

  org.get("/", need("viewer"), (c) => c.json(c.var.org));

  // F24: only an owner changes roles, their own included (the last owner cannot step down: the org would have
  // none). A new member is added the same way: the api has no email to invite with, so it takes a user who signed up.
  // The change is committed BEFORE it is announced, so a sync node that hears of it reads the new role.
  org.put("/members", need("owner"), async (c) => {
    const member = await c.var.scope.setMember({ ...(await body(c, SetMemberBody)), by: c.var.user.id });
    if (member === "no_user") return notFound(c);
    if (member === "last_owner") return fail(c, 409, "last_owner");
    await announce(c, { orgId: c.var.org.id, userId: member.userId });
    return c.json(member);
  });

  org.post("/workspaces", need("editor"), async (c) => c.json(await c.var.scope.createWorkspace(await body(c, CreateWorkspaceBody)), 201));
  org.get("/workspaces", need("viewer"), async (c) => {
    const page = await c.var.scope.listWorkspaces(pageQuery(c));
    return page ? c.json(page) : badCursor(c);
  });
  org.get("/workspaces/:id", need("viewer"), async (c) => {
    const ws = await c.var.scope.getWorkspace(c.req.param("id"));
    return ws ? c.json(ws) : notFound(c);
  });

  org.post("/workspaces/:id/documents", need("editor"), async (c) => {
    const { title } = await body(c, CreateDocumentBody);
    const doc = await c.var.scope.createDocument({ workspaceId: c.req.param("id"), title });
    return doc ? c.json(doc, 201) : notFound(c);
  });
  org.get("/workspaces/:id/documents", need("viewer"), async (c) => {
    const id = c.req.param("id");
    const query = pageQuery(c);
    if (!(await c.var.scope.getWorkspace(id))) return notFound(c);
    const page = await c.var.scope.listDocuments(id, query);
    return page ? c.json(page) : badCursor(c);
  });
  org.get("/documents/:id", need("viewer"), async (c) => {
    const doc = await c.var.scope.getDocument(c.req.param("id"));
    return doc ? c.json(doc) : notFound(c);
  });

  // F12: what this org's AI runs have consumed. Behind the org middleware like everything else about an
  // org, so another org's usage is the usual 404. ponytail: totals over all time; periods and limits are E9.5.
  // Owners only (E8.2): what the org spends is the business of whoever runs it, not of everyone who can look.
  org.get("/usage", need("owner"), async (c) => {
    const report = await c.var.scope.usage(pageQuery(c));
    return report ? c.json(report) : badCursor(c);
  });

  // F26: the org's audit trail (sign-ins, role and share changes, AI runs, ships, rejected pushes), newest first. Owners
  // only, as usage is. Read-only by construction: no route changes or removes an entry, and the database refuses the
  // app's role both anyway. Each entry was written by the action itself, in the same statement or transaction.
  org.get("/audit", need("owner"), async (c) => {
    const page = await c.var.scope.audit(pageQuery(c));
    return page ? c.json(page) : badCursor(c);
  });

  app.route("/orgs/:orgId", org);

  // Everything under /documents/:id: the path names no org, so the lookup itself is access-filtered (a member of the
  // org, or someone the document is shared with, E8.3), and the same row carries the caller's role for each route's
  // `need` (E8.2). Neither: 404, as for an org. So a revoked share's next /session is a 404, and its peer gives up.
  const document = new Hono<{ Variables: { user: User; doc: Document; role: Role } }>();
  document.use(async (c, next) => {
    const found = await db.getDocumentForMember(c.req.param("id") ?? "", c.var.user.id);
    if (!found) return notFound(c);
    c.set("doc", found.document);
    c.set("role", found.role);
    await next();
  });

  // The routing hook (SPEC §2.11): a peer never knows a sync address in advance, it asks here, and gets the
  // node that owns the room (E7.1), or any node when nobody does yet. A viewer opens the document too: to watch
  // it. What they may do inside is the sync server's business, which reads the role itself (the token says who,
  // never what they may do, so a role change is not waiting for a token to expire).
  document.post("/session", need("viewer"), async (c) => {
    const { doc } = c.var;
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

  // F25: an owner of the document's org shares it with someone outside the org (or changes the share), and revokes it.
  // Committed BEFORE it is announced, like a role change: every sync node re-reads that user's live sessions, and a
  // revoked one is closed. A token minted before the revoke is refused at the upgrade, which reads the row too.
  document.put("/shares", need("owner"), async (c) => {
    const { email, role } = await body(c, ShareBody);
    const member = await db.forOrg(c.var.doc.orgId).share({ documentId: c.var.doc.id, email, role, by: c.var.user.id });
    if (!member) return notFound(c); // nobody has that email (the api has no email to invite with)
    await announce(c, { orgId: c.var.doc.orgId, userId: member.userId });
    return c.json(member);
  });
  document.delete("/shares/:userId", need("owner"), async (c) => {
    const userId = c.req.param("userId");
    if (!(await db.forOrg(c.var.doc.orgId).unshare(c.var.doc.id, userId, c.var.user.id))) return notFound(c);
    await announce(c, { orgId: c.var.doc.orgId, userId });
    return c.body(null, 204);
  });

  // An AI run (F9) is a job: the row in Postgres IS the run; the queue only tells a worker to look. It edits the
  // document and costs money: editors and owners. Its ops carry its creator's role into the room (E8.2).
  document.post("/runs", need("editor"), async (c) => {
    const { doc } = c.var;
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
  document.post("/runs/:runId/cancel", need("editor"), async (c) => {
    const run = await db.forOrg(c.var.doc.orgId).cancelRun(c.var.doc.id, c.req.param("runId"));
    return run ? c.json(run) : notFound(c);
  });
  document.get("/runs/:runId", need("viewer"), async (c) => {
    const run = await db.forOrg(c.var.doc.orgId).getRun(c.var.doc.id, c.req.param("runId"));
    return run ? c.json(run) : notFound(c);
  });

  // F15: the document's running page. The canvas POSTs to make sure a preview is on its way and GETs,
  // once a second, where it answers: the address can change when a sandbox restarts, so it is never kept.
  // A viewer may open it: it shows the document, and changes nothing in it. The job row IS the preview.
  document.post("/preview", need("viewer"), async (c) => {
    const opened = await db.forOrg(c.var.doc.orgId).openPreview({ documentId: c.var.doc.id, createdBy: c.var.user.id });
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
  document.get("/preview", need("viewer"), async (c) => {
    const preview = await db.forOrg(c.var.doc.orgId).getPreview(c.var.doc.id);
    return preview ? c.json(publicPreview(preview, previewOrigin)) : notFound(c);
  });
  // F16b: the newest push to the document's branch that changed nothing, which the canvas shows as a banner.
  // The body is parsed with the contract: commit and file are an engineer's text.
  document.get("/conflict", need("viewer"), async (c) => {
    const conflict = await db.forOrg(c.var.doc.orgId).getConflict(c.var.doc.id);
    return conflict === undefined ? notFound(c) : c.json(DocumentConflict.parse({ conflict }));
  });

  // F17: Ship. A job, like a run: the row IS the ship, the queue only tells the ship worker (which alone holds the
  // Gitea token) to look. Presses coalesce into the ship still waiting (201 when this press made it, 200 when it
  // joined it), so a double click or two tabs never make two; a press while one runs queues the next, which reads
  // the document afresh. It opens a pull request in the org's name: editors and owners.
  document.post("/ship", need("editor"), async (c) => {
    const started = await db.forOrg(c.var.doc.orgId).startShip({ documentId: c.var.doc.id, createdBy: c.var.user.id });
    if (!started) return notFound(c);
    if (started.created) {
      // Left to the sweep if Redis is away, as a run is: the job exists, and it will be found.
      await enqueue(started.created).catch((err: unknown) => {
        process.stderr.write(`${JSON.stringify({ level: "warn", path: c.req.path, message: `enqueue failed, left to the sweep: ${describeError(err)}` })}\n`);
      });
    }
    return c.json(started.ship, started.created ? 201 : 200);
  });
  document.get("/ship", need("viewer"), async (c) => {
    const ship = await db.forOrg(c.var.doc.orgId).getShip(c.var.doc.id);
    return ship === undefined ? notFound(c) : c.json(DocumentShip.parse({ ship }));
  });

  app.route("/documents/:id", document);

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
