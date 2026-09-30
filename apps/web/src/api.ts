import { AuditPage, Document, DocumentConflict, DocumentShip, ErrorBody, Me, Org, Preview, Run, SessionResponse, Ship, User, Workspace } from "@noon/contracts";
import { z } from "zod";

// The caller is whoever signed in (E8.1): the session is an HttpOnly cookie the browser sends by itself on
// these same-origin requests. In development only, `?user=` still names the caller in a header (SPEC §2.16),
// so two browser windows can be two people without signing up twice; an api outside development ignores it.
const devUser = new URLSearchParams(location.search).get("user") ?? undefined;
const devHeaders: Record<string, string> = devUser === undefined ? {} : { "x-dev-user": devUser };

/** "The answer is no, and asking again will not change it": not found, not yours, not an id. */
class Refused extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** POSTs and checks the ANSWER against the shared contract: the server is another program, not a type. */
async function post<S extends z.ZodType>(path: string, schema: S, body?: unknown, headers: Record<string, string> = {}): Promise<z.infer<S>> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { ...devHeaders, ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new Refused(`POST ${path} answered ${String(res.status)}`, res.status);
  if (!res.ok) throw new Error(`POST ${path} answered ${String(res.status)}`);
  return schema.parse(await res.json());
}

/**
 * F27: a POST that makes a job. One press, one Idempotency-Key: when the answer is lost or is a 5xx, the retry sends
 * the same key and the api answers with the job the first attempt made, never a second one. A refusal is not retried.
 */
async function postJob<S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  const key = { "idempotency-key": crypto.randomUUID() };
  try {
    return await post(path, schema, body, key);
  } catch (problem) {
    if (problem instanceof Refused) throw problem;
    return post(path, schema, body, key);
  }
}

// --- Signing in (F23) ------------------------------------------------------------------------------
/** Who is signed in, or null when nobody is. */
export async function whoAmI(): Promise<User | null> {
  const res = await fetch("/api/auth/me", { headers: devHeaders });
  if (!res.ok) throw new Error(`GET /auth/me answered ${String(res.status)}`);
  return Me.parse(await res.json()).user;
}
/** The signed-in user, or the api's error NAME (invalid_credentials, email_taken, invalid_body...) for the form to explain. */
async function authenticate(path: string, body: unknown): Promise<User | ErrorBody["error"]> {
  const res = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return User.parse(await res.json());
  const error = ErrorBody.safeParse(await res.json().catch(() => undefined));
  return error.success ? error.data.error : "internal";
}
export const signUp = (body: { email: string; name: string; password: string }) => authenticate("/auth/signup", body);
export const signIn = (body: { email: string; password: string }) => authenticate("/auth/signin", body);
export async function signOut(): Promise<void> {
  const res = await fetch("/api/auth/signout", { method: "POST" });
  if (!res.ok) throw new Error(`POST /auth/signout answered ${String(res.status)}`);
}

/** A fresh org, workspace and document. ponytail: the real flow (pick an org, a workspace) is not built; ceiling: every document is a new org. */
export async function createDocument(owner: User): Promise<string> {
  const org = await post("/orgs", Org, { name: `${owner.name}'s org` });
  const workspace = await post(`/orgs/${org.id}/workspaces`, Workspace, { name: "Designs" });
  const doc = await post(`/orgs/${org.id}/workspaces/${workspace.id}/documents`, Document, { title: "Untitled" });
  return doc.id;
}

/**
 * peer-client's contract for session(): THROW = "try again later" (the network is down);
 * NULL = "give up" (there is no such document for you). Mixing them up is an endless retry.
 */
export async function openSession(documentId: string): Promise<SessionResponse | null> {
  try {
    return await post(`/documents/${documentId}/session`, SessionResponse);
  } catch (problem) {
    if (problem instanceof Refused) return null;
    throw problem;
  }
}

// --- AI runs (F9, F10) -----------------------------------------------------------------------------
/** "busy": this document already has a run going (409). Anything else that fails is thrown. */
export async function startRun(documentId: string, instruction: string): Promise<Run | "busy"> {
  try {
    return await postJob(`/documents/${documentId}/runs`, Run, { instruction });
  } catch (problem) {
    if (problem instanceof Refused && problem.status === 409) return "busy";
    throw problem;
  }
}
export const cancelRun = (run: Run): Promise<Run> => post(`/documents/${run.documentId}/runs/${run.id}/cancel`, Run);
export async function readRun(run: Run): Promise<Run> {
  const res = await fetch(`/api/documents/${run.documentId}/runs/${run.id}`, { headers: devHeaders });
  if (!res.ok) throw new Error(`GET run answered ${String(res.status)}`);
  return Run.parse(await res.json());
}

// --- The preview (F15) -----------------------------------------------------------------------------
/** Makes sure the document's preview is on its way, and says how it is. "busy": the org already holds its share of sandboxes (409). */
export async function openPreview(documentId: string): Promise<Preview | "busy"> {
  try {
    return await post(`/documents/${documentId}/preview`, Preview);
  } catch (problem) {
    if (problem instanceof Refused && problem.status === 409) return "busy";
    throw problem;
  }
}
/** Where the preview answers NOW. Parsed with the contract: only an http(s) URL on the loopback or under /preview/ (and Preview.tsx: of THIS origin) reaches an iframe. */
export async function readPreview(documentId: string): Promise<Preview> {
  const res = await fetch(`/api/documents/${documentId}/preview`, { headers: devHeaders });
  if (!res.ok) throw new Error(`GET preview answered ${String(res.status)}`);
  return Preview.parse(await res.json());
}

// --- Conflicts (F16b) ------------------------------------------------------------------------------
/**
 * The newest push to the document's branch that changed nothing, or null. Parsed with the contract: commit and
 * file are an engineer's text. "gone": not found or not yours (404), and asking again will not change it.
 */
export async function readConflict(documentId: string): Promise<DocumentConflict["conflict"] | "gone"> {
  const res = await fetch(`/api/documents/${documentId}/conflict`, { headers: devHeaders });
  if (res.status === 404) return "gone";
  if (!res.ok) throw new Error(`GET conflict answered ${String(res.status)}`);
  return DocumentConflict.parse(await res.json()).conflict;
}

// --- Ship (F17) ------------------------------------------------------------------------------------
/** Presses Ship: the ship still waiting for this document, or a new one. Parsed with the contract (the pull request link goes into an href). */
export const startShip = (documentId: string): Promise<Ship> => postJob(`/documents/${documentId}/ship`, Ship);
/** The document's newest ship, or null when it was never shipped. */
export async function readShip(documentId: string): Promise<Ship | null> {
  const res = await fetch(`/api/documents/${documentId}/ship`, { headers: devHeaders });
  if (!res.ok) throw new Error(`GET ship answered ${String(res.status)}`);
  return DocumentShip.parse(await res.json()).ship;
}

// --- Audit (F26) -----------------------------------------------------------------------------------
/** The orgs the signed-in person belongs to. ponytail: the first page only (50); ceiling: a 51st org is not listed; upgrade: page on. */
export async function listOrgs(): Promise<Org[]> {
  const res = await fetch("/api/orgs", { headers: devHeaders });
  if (!res.ok) throw new Error(`GET /orgs answered ${String(res.status)}`);
  return z.object({ items: z.array(Org) }).parse(await res.json()).items;
}
/** The org, or "gone": not found or not a member (404). */
export async function readOrg(orgId: string): Promise<Org | "gone"> {
  const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}`, { headers: devHeaders });
  if (res.status === 404) return "gone";
  if (!res.ok) throw new Error(`GET org answered ${String(res.status)}`);
  return Org.parse(await res.json());
}
/**
 * One page of the org's audit trail, newest first, parsed with the contract (its details are what people typed).
 * "forbidden": a member who is not an owner (403). "gone": not found or not a member (404).
 */
export async function readAudit(orgId: string, cursor?: string): Promise<AuditPage | "forbidden" | "gone"> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/audit${query}`, { headers: devHeaders });
  if (res.status === 403) return "forbidden";
  if (res.status === 404) return "gone";
  if (!res.ok) throw new Error(`GET audit answered ${String(res.status)}`);
  return AuditPage.parse(await res.json());
}
