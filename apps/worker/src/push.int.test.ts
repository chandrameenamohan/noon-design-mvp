import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { generate } from "@noon/codegen";
import type { Doc, Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOp, emptyDoc } from "@noon/doc-model";
import { createTestDb, type TestDb } from "../../../packages/db/src/testing.ts";
import { connect, TEST_ORG, TEST_SECRET, useSyncServer, type TestPeer } from "../../sync/src/testing.ts";
import { createGitPeer } from "./git.ts";
import { localOrigin, type LocalOrigin } from "./git-testing.ts";
import { createPushApplier, type PushOutcome } from "./push.ts";
import { pagePath } from "./sandbox.ts";

// E5.3b, integration:push-becomes-ops. Real git (a local bare repo stands in for Gitea, as in git.int.test.ts),
// real Postgres for the git peer's inbox, the REAL sync server and the REAL peer-client. A person is in the
// document the whole time: what they receive is what the canvas would show.

const DOC = "0f9c7a0e-1b2c-4d3e-8f00-00000000e53b";
const BRANCH = `noon/${DOC}`;
const ctx = useSyncServer();
let t: TestDb;
let local: LocalOrigin;
let person: TestPeer;
/** The document as the person holds it, rebuilt from the ops the room sent them. */
let doc: Doc;
let outcomes: PushOutcome[];
let peer: ReturnType<typeof createGitPeer>;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.rawQuery("delete from git_events");
  local = await localOrigin("noon-push-");
  const toOps = createPushApplier({ sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest, documentOrg: (id) => Promise.resolve(id === DOC ? TEST_ORG : undefined), shippedCommit: (sha) => t.db.gitStore().shippedCommit(sha) });
  outcomes = [];
  peer = createGitPeer({ seed: { url: local.origin }, dir: join(local.root, "peer"), store: t.db.gitStore(), log: () => undefined, apply: async (event, page, base) => { outcomes.push(await toOps(event, page, base)); } });
  await peer.reconcile();
  while (await peer.processNext());
  person = await connect(ctx.server.url, DOC);
  doc = emptyDoc();
  return () => {
    person.close();
    local.remove();
  };
});

const commit = (files: Record<string, string>, message: string, branch = BRANCH): Promise<string> => local.commit(files, message, branch, true);
/** The page file for a document, exactly as codegen writes it. */
const fileOf = (page: Doc): string => {
  const generated = generate(page, manifest);
  if (!generated.ok) throw new Error(generated.reason);
  return generated.tsx;
};
/** What the person does on the canvas: an op, then its echo from the room. */
async function edit(op: Op): Promise<void> {
  const opId = person.send(op);
  await person.next("op", (m) => m.opId === opId);
  doc = applyOp(doc, op);
}
/** Commits the page on the document's branch and lets the git peer work: what a push plus its webhook does. */
async function push(page: Doc | string, branch = BRANCH, beforeTheWebhook: (sha: string) => Promise<void> = () => Promise.resolve()): Promise<string> {
  const sha = await commit({ [pagePath(DOC)]: typeof page === "string" ? page : fileOf(page) }, "edit the page", branch);
  await beforeTheWebhook(sha);
  await peer.reconcile();
  while (await peer.processNext());
  return sha;
}
const button = (nodeId: string, label: string, index = 99): Op => ({ type: "add_node", nodeId, parentId: "root", index, component: "Button", props: { label } });
const setLabel = (nodeId: string, value: string): Op => ({ type: "set_prop", nodeId, key: "label", value });
const gitOps = (): unknown[] => person.inbox.filter((m) => m.type === "op" && m.actor.kind === "git");

test("an in-shape change to the page reaches the open document as the minimal ops, stamped actor.kind=git with the commit", async () => {
  await edit(button("b1", "Before"));
  await edit(button("b2", "Other"));
  // The first push of the branch carries the page as the document already is: nothing to do.
  await push(doc);
  expect(outcomes.at(-1)).toEqual({ kind: "applied", ops: 0, refused: 0 });

  const engineer = [setLabel("b1", "From git"), { type: "move_node", nodeId: "b2", newParentId: "root", index: 0 }, button("b3", "New")] satisfies Op[];
  const sha = await push(engineer.reduce(applyOp, doc));
  expect(outcomes.at(-1)).toEqual({ kind: "applied", ops: 3, refused: 0 });
  const [eventId] = ((await t.rawQuery("select id from git_events where after_sha = $1", [sha])) as { rows: { id: string }[] }).rows.map((r) => r.id);
  const actor = { kind: "git", id: eventId, runId: sha };
  expect(await person.next("op", (m) => m.actor.kind === "git")).toMatchObject({ actor, op: { type: "move_node", nodeId: "b2", index: 0 } });
  expect(await person.next("op", (m) => m.actor.kind === "git")).toMatchObject({ actor, op: { type: "add_node", nodeId: "b3", props: { label: "New" } } });
  expect(await person.next("op", (m) => m.actor.kind === "git")).toMatchObject({ actor, op: setLabel("b1", "From git") });
  expect(gitOps()).toHaveLength(3); // minimal: nothing for what the engineer did not touch
});

test("the push replays the engineer's change on the document as it is NOW: canvas edits made since stay", async () => {
  await edit(button("b1", "Before"));
  await edit(button("b2", "Other"));
  const base = doc;
  await push(base);
  // On the canvas, after the file was pushed: b2 is renamed and b1 removed.
  await edit(setLabel("b2", "renamed on the canvas"));
  await edit({ type: "remove_node", nodeId: "b1" });
  // The engineer, from the old file, edits b1 (gone now) and adds b3.
  await push([setLabel("b1", "too late"), button("b3", "New")].reduce(applyOp, base));
  expect(outcomes.at(-1)).toEqual({ kind: "applied", ops: 1, refused: 0 });
  expect(await person.next("op", (m) => m.actor.kind === "git")).toMatchObject({ op: { type: "add_node", nodeId: "b3" } });
  expect(gitOps()).toHaveLength(1); // no revert of the rename, no b1 brought back
});

test("only the document's own branch speaks for it; a page out of shape or re-using a removed id sends nothing", async () => {
  await edit(button("b1", "Before"));
  await push(doc);
  await push(applyOp(doc, setLabel("b1", "on main")), "main");
  expect(outcomes.at(-1)).toEqual({ kind: "skipped", why: "other_branch" });

  await push(fileOf(doc).replace('label={"Before"}', "label={name}"));
  expect(outcomes.at(-1)).toMatchObject({ kind: "conflict", reason: "non_literal_prop" });

  // b2 was in the page, then removed by a push; a later push that brings back the same id is refused whole.
  const withB2 = applyOp(doc, button("b2", "Temporary"));
  await push(withB2);
  await push(doc);
  expect(outcomes.at(-1)).toMatchObject({ kind: "applied", ops: 1 });
  await push(applyOp(applyOp(doc, button("b2", "Back")), setLabel("b1", "with it")));
  expect(outcomes.at(-1)).toMatchObject({ kind: "conflict", reason: "reused_node_id" });

  const other: Doc = { rootId: "another", nodes: { another: { id: "another", component: "Page", props: {}, parentId: null, children: [] } } };
  await push(other);
  expect(outcomes.at(-1)).toMatchObject({ kind: "conflict", reason: "root_mismatch" });
  expect(gitOps().map((m) => (m as { op: Op }).op.type)).toEqual(["add_node", "remove_node"]); // b2 in, b2 out: nothing else ever left
});

test("a commit Ship made is skipped: a canvas edit that raced the ship stays (E5.5)", async () => {
  await edit(button("b1", "Before"));
  await push(doc); // the branch as it was: the last ship, or an engineer's push
  await edit(setLabel("b1", "Shipped"));
  const shipped = doc; // what Ship read and generated
  await edit(setLabel("b1", "edited on the canvas while shipping"));
  // Ship records its commit on its job BEFORE it pushes, so the commit is known by the time the push is seen.
  const org = await t.createOrg("ship");
  const workspace = await t.db.forOrg(org.id).createWorkspace({ name: "w" });
  const document = await t.db.forOrg(org.id).createDocument({ workspaceId: workspace.id, title: "d" });
  await push(shipped, BRANCH, async (sha) => {
    await t.rawQuery("insert into jobs (org_id, document_id, queue, status, started_at, input, output) values ($1, $2, 'ship', 'running', now(), '{}', $3)", [org.id, document?.id, JSON.stringify({ commit: sha, pr: null })]);
  });
  expect(outcomes.at(-1)).toEqual({ kind: "skipped", why: "shipped" });
  // Diffed, "Before" -> "Shipped" would have been replayed onto the room: the racing edit, undone.
  expect(gitOps()).toEqual([]);
});
