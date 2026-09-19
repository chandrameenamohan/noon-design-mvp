import { Document, Org, SessionResponse, Workspace } from "@noon/contracts";
import type { z } from "zod";

// Until epic 8 the api takes the caller's identity from a header, in development only (SPEC §2.16).
// `?user=` lets two browser windows be two people; without it everyone is the same dev user.
const devUser = new URLSearchParams(location.search).get("user") ?? "dev@example.com";

/** POSTs and checks the ANSWER against the shared contract: the server is another program, not a type. */
async function post<S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "x-dev-user": devUser, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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

export const openSession = (documentId: string): Promise<SessionResponse> => post(`/documents/${documentId}/session`, SessionResponse);
