import { Document, Org, Preview, Run, SessionResponse, Workspace } from "@noon/contracts";
import type { z } from "zod";

// Until epic 8 the api takes the caller's identity from a header, in development only (SPEC §2.16).
// `?user=` lets two browser windows be two people; without it everyone is the same dev user.
const devUser = new URLSearchParams(location.search).get("user") ?? "dev@example.com";

/** "The answer is no, and asking again will not change it": not found, not yours, not an id. */
class Refused extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** POSTs and checks the ANSWER against the shared contract: the server is another program, not a type. */
async function post<S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "x-dev-user": devUser, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new Refused(`POST ${path} answered ${String(res.status)}`, res.status);
  if (!res.ok) throw new Error(`POST ${path} answered ${String(res.status)}`);
  return schema.parse(await res.json());
}

/** A fresh org, workspace and document. ponytail: the real flow (pick an org, a workspace) comes with auth in epic 8. */
export async function createDocument(): Promise<string> {
  const org = await post("/orgs", Org, { name: `${devUser}'s org` });
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
    return await post(`/documents/${documentId}/runs`, Run, { instruction });
  } catch (problem) {
    if (problem instanceof Refused && problem.status === 409) return "busy";
    throw problem;
  }
}
export const cancelRun = (run: Run): Promise<Run> => post(`/documents/${run.documentId}/runs/${run.id}/cancel`, Run);
export async function readRun(run: Run): Promise<Run> {
  const res = await fetch(`/api/documents/${run.documentId}/runs/${run.id}`, { headers: { "x-dev-user": devUser } });
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
  const res = await fetch(`/api/documents/${documentId}/preview`, { headers: { "x-dev-user": devUser } });
  if (!res.ok) throw new Error(`GET preview answered ${String(res.status)}`);
  return Preview.parse(await res.json());
}
