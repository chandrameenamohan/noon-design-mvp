import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { generate } from "@noon/codegen";
import type { Doc, Op, ShipOutput } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import type { Job } from "@noon/db";
import { applyOp, emptyDoc } from "@noon/doc-model";
import { bootstrapGitea } from "../../../scripts/gitea.ts";
import { connect, TEST_ORG, TEST_SECRET, useSyncServer, type TestPeer } from "../../sync/src/testing.ts";
import { git, localOrigin } from "./git-testing.ts";
import { pagePath } from "./sandbox.ts";
import { createShipHandler, shipPage } from "./ship.ts";

// E5.5 (F17, SPEC §8 step 9), integration:ship-once-twice-same-pr-byte-identical. The dev stack's REAL Gitea (a
// repo of this file's own, deleted after), real git, the REAL sync server with a person editing in the room, and
// the ship handler as the worker runs it. What is compared is Gitea's own copy of the file against a fresh
// codegen of the document the person holds.
const GITEA = `http://127.0.0.1:${process.env["GITEA_PORT"] ?? "3002"}`;
const TOKEN = process.env["GITEA_TOKEN"] ?? "";
const REPO = `ship-${randomUUID().slice(0, 8)}`;
const API = `${GITEA}/api/v1/repos/noon/${REPO}`;
const seed = { url: `${GITEA}/noon/${REPO}.git`, auth: { user: "noon", token: TOKEN } };
const ctx = useSyncServer();
const asGitea = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: `token ${TOKEN}`, "content-type": "application/json" } });
  if (!res.ok) throw new Error(`Gitea ${path} -> ${String(res.status)}`);
  return (res.headers.get("content-type")?.includes("json") ? res.json() : res.text()) as Promise<T>;
};
type Pull = { number: number; head: { ref: string; sha: string } };
const openPulls = async (branch: string): Promise<Pull[]> => (await asGitea<Pull[]>("/pulls?state=open&limit=50")).filter((p) => p.head.ref === branch);
const pageOnBranch = (documentId: string): Promise<string> => asGitea<string>(`/raw/${pagePath(documentId)}?ref=${encodeURIComponent(`noon/${documentId}`)}`);
const tipOf = async (documentId: string): Promise<string> => (await asGitea<{ commit: { id: string } }>(`/branches/${encodeURIComponent(`noon/${documentId}`)}`)).commit.id;
const fileOf = (doc: Doc): string => {
  const generated = generate(doc, manifest);
  if (!generated.ok) throw new Error(generated.reason);
  return generated.tsx;
};

let documentId: string;
let person: TestPeer;
let doc: Doc;
/** Every report of every ship, in order, with the job that made it. */
let outputs: { jobId: string; output: ShipOutput }[];
/** One press of Ship, as the worker runs it: a job of its own, to its end. Resolves with what it reported last. */
async function ship(): Promise<ShipOutput | undefined> {
  const handler = createShipHandler({
    sessions: { secret: TEST_SECRET, syncUrl: ctx.server.url }, manifest, seed, stopping: new AbortController().signal,
    stillMember: () => Promise.resolve(true),
    report: (reporting, output) => { outputs.push({ jobId: reporting.id, output }); return Promise.resolve(); },
  });
  const job: Job = { id: randomUUID(), orgId: TEST_ORG, documentId, queue: "ship", input: {}, createdBy: person.userId };
  await handler(job, new AbortController().signal);
  return outputs.filter((each) => each.jobId === job.id).at(-1)?.output;
}
async function edit(op: Op): Promise<void> {
  const opId = person.send(op);
  await person.next("op", (m) => m.opId === opId);
  doc = applyOp(doc, op);
}
const button = (nodeId: string, label: string): Op => ({ type: "add_node", nodeId, parentId: "root", index: 99, component: "Button", props: { label } });

beforeAll(async () => {
  if (!TOKEN) throw new Error("GITEA_TOKEN is not in .env: run ./init.sh");
  await bootstrapGitea({ url: GITEA, user: "noon", token: TOKEN, repo: REPO, webhook: { url: "http://api:3000/webhooks/gitea", secret: "a-webhook-secret" } });
}, 60_000);
afterAll(async () => {
  await fetch(API, { method: "DELETE", headers: { authorization: `token ${TOKEN}` } });
});
beforeEach(async () => {
  documentId = randomUUID();
  person = await connect(ctx.server.url, documentId);
  doc = emptyDoc();
  outputs = [];
  return () => { person.close(); };
});

test("Ship once, Ship again: ONE open pull request, whose file is byte-identical to a fresh codegen of the document each time", async () => {
  await edit(button("b1", "Pay"));
  const first = await ship();
  const branch = `noon/${documentId}`;
  expect(first?.commit).toMatch(/^[0-9a-f]{40}$/u);
  expect(first?.pr).toMatchObject({ number: expect.any(Number) as number, url: expect.stringContaining(`/noon/${REPO}/pulls/`) as string });
  expect(await pageOnBranch(documentId)).toBe(fileOf(doc));
  expect(await openPulls(branch)).toEqual([expect.objectContaining({ number: first?.pr?.number, head: expect.objectContaining({ sha: first?.commit }) as unknown })]);

  await edit(button("b2", "Cancel"));
  await edit({ type: "set_prop", nodeId: "b1", key: "label", value: "Pay now" });
  const second = await ship();
  expect(second?.pr).toEqual(first?.pr); // the same pull request, updated
  expect(second?.commit).not.toBe(first?.commit);
  expect(await pageOnBranch(documentId)).toBe(fileOf(doc));
  expect(await openPulls(branch)).toEqual([expect.objectContaining({ number: first?.pr?.number, head: expect.objectContaining({ sha: second?.commit }) as unknown })]);

  // Nothing changed since: no commit, the branch where it was, the same pull request.
  const third = await ship();
  expect(third).toEqual({ commit: null, pr: first?.pr });
  expect(await tipOf(documentId)).toBe(second?.commit);
  // The commit was reported BEFORE it was pushed: the git peer must know a push is Ship's by the time it sees it.
  expect(outputs.slice(0, 2).map((each) => each.output)).toEqual([{ commit: first?.commit, pr: null }, first]);
}, 60_000);

test("two ships at once still make ONE pull request, and the branch ends holding the document's page", async () => {
  await edit(button("b1", "Pay"));
  const [a, b] = await Promise.all([ship(), ship()]);
  expect(a?.pr?.number).toBe(b?.pr?.number);
  expect(await openPulls(`noon/${documentId}`)).toHaveLength(1);
  expect(await pageOnBranch(documentId)).toBe(fileOf(doc));
}, 60_000);

test("with an engineer's out-of-shape page on the branch (the conflict banner's case), Ship ships on top of it, never over it", async () => {
  await edit(button("b1", "Pay"));
  // The engineer's commit, through Gitea's API: the branch made from main, holding the page with a hook in it.
  const broken = fileOf(doc).replace(/\{\n/u, "{\n  const [count] = useState(0);\n");
  const engineers = await asGitea<{ commit: { sha: string } }>(`/contents/${pagePath(documentId)}`, {
    method: "POST", body: JSON.stringify({ content: Buffer.from(broken).toString("base64"), message: "count clicks", branch: "main", new_branch: `noon/${documentId}` }),
  });
  expect(await pageOnBranch(documentId)).toBe(broken);

  const shipped = await ship();
  expect(await pageOnBranch(documentId)).toBe(fileOf(doc)); // back in shape, byte for byte
  expect((await asGitea<{ parents: { sha: string }[] }>(`/git/commits/${shipped?.commit ?? ""}`)).parents.map((p) => p.sha)).toEqual([engineers.commit.sha]);
  expect(await openPulls(`noon/${documentId}`)).toHaveLength(1);
}, 60_000);

test("a branch that moves under the push (a racing push) is built on again, on top; one that never stops moving fails as branch_busy", async () => {
  const local = await localOrigin("noon-ship-race-");
  try {
    const id = randomUUID();
    const recorded: string[] = [];
    const engineer = async (): Promise<void> => { await local.commit({ [`notes-${String(recorded.length)}.md`]: "mine\n" }, "an engineer's push", `noon/${id}`, true); };
    // The engineer pushes exactly between Ship's commit and its push, once.
    const commit = await shipPage({ seed: { url: local.origin }, documentId: id, tsx: "the page\n", signal: new AbortController().signal, recordCommit: async (made) => { recorded.push(made); if (recorded.length === 1) await engineer(); } });
    expect(recorded).toHaveLength(2);
    expect(commit).toBe(recorded[1]);
    expect(await git(local.origin, "rev-parse", `refs/heads/noon/${id}`)).toBe(commit);
    expect(await git(local.origin, "show", `${commit ?? ""}:${pagePath(id)}`)).toBe("the page");
    expect(await git(local.origin, "show", `${commit ?? ""}:notes-1.md`)).toBe("mine"); // the engineer's commit is under it, kept

    const endless = shipPage({ seed: { url: local.origin }, documentId: id, tsx: "another page\n", signal: new AbortController().signal, recordCommit: engineer });
    await expect(endless).rejects.toMatchObject({ reason: "branch_busy" });
  } finally {
    local.remove();
  }
});
