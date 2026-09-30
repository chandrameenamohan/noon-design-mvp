import { expect, test } from "vitest";
import { Document, DocumentConflict, Org, Workspace } from "@noon/contracts";
import { useTestServer } from "./testing.ts";

// E5.4 (F16b): the canvas asks for its document's conflict; the git peer is what writes it.
const ctx = useTestServer();
const as = (user: string, path: string) => ctx.fetch(path, { headers: { "x-dev-user": user } });
const post = async (user: string, path: string, body: unknown): Promise<unknown> =>
  (await ctx.fetch(path, { method: "POST", headers: { "x-dev-user": user, "content-type": "application/json" }, body: JSON.stringify(body) })).json();

async function aDocument(owner: string): Promise<Document> {
  const org = Org.parse(await post(owner, "/orgs", { name: "Conflicts" }));
  const ws = Workspace.parse(await post(owner, `/orgs/${org.id}/workspaces`, { name: "ws" }));
  return Document.parse(await post(owner, `/orgs/${org.id}/workspaces/${ws.id}/documents`, { title: "Checkout" }));
}
const commit = "c".repeat(40);

test("a refused push is the document's conflict until one is applied; only members may read it", async () => {
  const doc = await aDocument("ann@example.com");
  const read = async () => DocumentConflict.parse(await (await as("ann@example.com", `/documents/${doc.id}/conflict`)).json());
  expect(await read()).toEqual({ conflict: null });

  const git = ctx.db.db.gitStore();
  // The file name is an engineer's: stored and answered as it was written, markup and all (the canvas renders text).
  await git.recordConflict(doc.id, { commit: "a".repeat(40), file: "src/pages/<b>old</b>.tsx", reason: "spread", detail: "line 1" });
  await git.recordConflict(doc.id, { commit, file: `src/pages/noon-${doc.id}.tsx`, reason: "hook", detail: "x".repeat(1000) });
  const { conflict } = await read();
  expect(conflict).toMatchObject({ commit, file: `src/pages/noon-${doc.id}.tsx`, reason: "hook", detail: "x".repeat(300) });

  expect((await as("bob@example.com", `/documents/${doc.id}/conflict`)).status).toBe(404);
  await git.clearConflict(doc.id);
  expect(await read()).toEqual({ conflict: null });
});

test("a reason outside the contract is a caller's bug, and a document that is gone takes no conflict", async () => {
  const git = ctx.db.db.gitStore();
  const doc = await aDocument("ann@example.com");
  await expect(git.recordConflict(doc.id, { commit, file: "f", reason: "made_up" as "hook", detail: "" })).rejects.toThrow();
  await git.recordConflict("0f9c7a0e-1b2c-4d3e-8f00-000000000000", { commit, file: "f", reason: "hook", detail: "" });
  expect(await ctx.db.rawQuery("select count(*)::int as n from document_conflicts where document_id = '0f9c7a0e-1b2c-4d3e-8f00-000000000000'")).toMatchObject({ rows: [{ n: 0 }] });
});
