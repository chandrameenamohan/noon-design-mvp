import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { AuditPage, Document, Member, Org, Run, UsageReport, Workspace, type Doc } from "@noon/contracts";
import { box, button, layer, tile, treeOf } from "./editor.ts";
import { expect, test } from "./fixtures.ts";
import { closePulls, openPullsOf, pageInGitea, pageOf, pushPage, welcomeOf } from "./gitea.ts";

// e2e:spec-scenario (SPEC §8, Z.1): the browser half of the end-to-end scenario, in its order, on ONE document, with
// every server real and from source except the model (e2e/stub-worker.ts), on TWO sync nodes
// (playwright.scenario.config.ts). The shell half (./init.sh and `make check` on a clean clone, `make sim`, `make
// chaos` for the partition, the paused node and the killed worker, the drift guard, the handbook) is
// scripts/spec-scenario.sh, which runs this spec in the middle: `make scenario`.
const stamp = String(Date.now());
const owner = `e2e-${stamp}-scenario-owner@example.com`;
const viewer = `e2e-${stamp}-scenario-viewer@example.com`;
const outsider = `e2e-${stamp}-scenario-outsider@example.com`;
const password = "correct horse battery";
const as = (email: string) => ({ headers: { "x-dev-user": email } });
test.setTimeout(480_000);
// The owner's socket to the node killed in step 7, and the second it spends dialling the dead port before /session
// names the other node. Expected here, nowhere else.
test.use({ allowedConsole: /WebSocket connection to 'ws:\/\/localhost:310[14]\/documents\/[^']+' failed/u });

/** The sync node a page is on now: the port of the last room socket it opened. Called before the page connects. */
function nodeOf(p: Page): () => string {
  let port = "";
  p.on("websocket", (ws) => { if (ws.url().includes("/documents/")) port = new URL(ws.url()).port; });
  return () => port;
}
const label = (p: Page) => p.locator("[data-component=Button] > .node-props").first();
async function setLabel(p: Page, value: string): Promise<void> {
  await p.getByLabel("label", { exact: true }).fill(value);
  await p.getByLabel("label", { exact: true }).blur();
}
/** The document with one node's label changed: what an engineer's edit of the generated page parses to. */
const relabel = (doc: Doc, nodeId: string, to: string): Doc => {
  const node = doc.nodes[nodeId];
  if (!node) throw new Error(`no node ${nodeId}`);
  return { ...doc, nodes: { ...doc.nodes, [nodeId]: { ...node, props: { ...node.props, label: to } } } };
};
const texts = (p: Page) => p.locator("[data-component=Text]");

test("SPEC §8: sign-up to audit trail on two sync nodes, with the AI, git, a node killed, a preview and a ship", async ({ page, browser, request }) => {
  // --- 2. The owner signs up, makes an org, a workspace and a document; invites a viewer; shares with an outsider. (F2, F23-F25)
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in" });
  await form.getByLabel("Email").fill(owner);
  await form.getByLabel("Password").fill(password);
  await form.getByLabel("Name").fill("Owen");
  await form.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByText(`Signed in as Owen (${owner})`)).toBeVisible();
  const api = page.request; // carries the owner's session cookie
  const org = Org.parse(await (await api.post("/api/orgs", { data: { name: `Scenario ${stamp}` } })).json());
  const badWorkspace = await api.post(`/api/orgs/${org.id}/workspaces`, { data: {} });
  expect(badWorkspace.status()).toBe(400);
  expect(JSON.stringify(await badWorkspace.json())).toContain(`"field":"name"`); // the failing field, named
  const workspace = Workspace.parse(await (await api.post(`/api/orgs/${org.id}/workspaces`, { data: { name: "Checkout" } })).json());
  const created = await api.post(`/api/orgs/${org.id}/workspaces/${workspace.id}/documents`, { data: { title: "Payment" } });
  expect(created.status()).toBe(201);
  const documentId = Document.parse(await created.json()).id;
  expect(JSON.stringify(await (await api.get(`/api/orgs/${org.id}/workspaces/${workspace.id}/documents`)).json())).toContain(documentId);
  expect((await request.get(`/api/orgs/${org.id}`)).status()).toBe(401); // nobody signed in
  // Out and in again: the sign-in the org's audit trail hears of (at sign-up there was no org yet). Home's own
  // request for the orgs first: signing out under it makes it a 401 the browser logs.
  await page.reload();
  await expect(page.getByRole("link", { name: `Audit trail of ${org.name}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await form.getByLabel("Email").fill(owner);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as Owen (${owner})`)).toBeVisible();

  for (const email of [viewer, outsider]) expect((await request.get("/api/auth/me", as(email))).status()).toBe(200); // the dev header creates them
  expect(Member.parse(await (await api.put(`/api/orgs/${org.id}/members`, { data: { email: viewer, role: "viewer" } })).json()).role).toBe("viewer");
  const share = Member.parse(await (await api.put(`/api/documents/${documentId}/shares`, { data: { email: outsider, role: "editor" } })).json());
  expect(share.role).toBe("editor");
  expect((await request.get(`/api/orgs/${org.id}/documents/${documentId}`, as(outsider))).status()).toBe(404); // outside the org: not even there

  // --- 3. Owner and editor on the document: cursors, a small tree, the same prop at once; the viewer; a refusal. (F3-F7, F20, F24)
  const ownerNode = nodeOf(page);
  await page.goto(`/?doc=${documentId}`);
  await expect(page.getByRole("status")).toHaveText("live");
  const editor = await (await browser.newContext()).newPage();
  const editorNode = nodeOf(editor);
  await editor.goto(`/?user=${outsider}&doc=${documentId}`);
  await expect(editor.getByRole("status")).toHaveText("live");
  expect(["3101", "3104"]).toContain(ownerNode());
  expect(editorNode()).toBe(ownerNode()); // one room globally: both on the node that holds the document's lease

  await expect(page.getByRole("list", { name: "Also here" }).getByRole("listitem")).toContainText(outsider.split("@")[0] ?? ""); // its name, as the api vouches for it
  for (const [mover, watcher] of [[page, editor], [editor, page]] as const) {
    const canvas = await box(mover, ".canvas");
    await mover.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await expect(watcher.locator("[data-presence-cursor]")).toHaveCount(1);
  }

  await tile(page, "Card").click(); // selected once added: the next lands inside it
  await tile(page, "Stack").click();
  await expect(editor.locator("[data-component=Card] [data-component=Stack]")).toHaveCount(1);
  await layer(editor, "Page").click();
  await tile(editor, "Button").click();
  await expect(page.locator("[data-component=Button]")).toHaveCount(1);
  await layer(page, "Button 1").click(); // the editor's button is selected on its side already
  await Promise.all([setLabel(page, "Pay (owner)"), setLabel(editor, "Pay (editor)")]); // the same prop, at once
  for (const each of [page, editor]) await expect(each.getByText("saved", { exact: true })).toBeVisible();
  await expect.poll(async () => label(page).textContent()).toMatch(/^label=Pay \((owner|editor)\)$/u);
  await expect.poll(async () => label(editor).textContent()).toBe(await label(page).textContent()); // converged on the op sequenced last
  expect(await treeOf(editor)).toBe(await treeOf(page));

  const watcher = await (await browser.newContext()).newPage();
  const viewerUrl = `/?user=${viewer}&doc=${documentId}`;
  await watcher.goto(viewerUrl);
  await expect(watcher.getByRole("status")).toHaveText("live");
  expect(await treeOf(watcher)).toBe(await treeOf(page));
  await layer(page, "Page").click();
  await tile(page, "Text").click();
  await expect(texts(watcher)).toHaveCount(1); // live
  await tile(watcher, "Card").click();
  await expect(watcher.getByRole("alert").filter({ hasText: "You can view this document but not edit it." })).toBeVisible();
  await expect(watcher.locator("[data-component=Card]")).toHaveCount(1); // its own card was undone
  await expect(page.locator("[data-component=Card]")).toHaveCount(1); // and never reached anyone

  await layer(page, "Card 1").click();
  await page.getByLabel("Move into", { exact: true }).selectOption({ label: "Stack 1" }); // into its own child
  await button(page, "Move").click();
  await expect(page.getByRole("alert")).toHaveText(/cannot be moved inside itself/u);
  await expect(editor.locator("[data-component=Card] [data-component=Stack]")).toHaveCount(1);
  await button(page, "Dismiss").click();

  // Two documents may live on different nodes: new ones land on either until one lands on the other.
  const elsewhere = await (await browser.newContext()).newPage();
  const elsewhereNode = nodeOf(elsewhere);
  await expect.poll(async () => {
    const other = Document.parse(await (await api.post(`/api/orgs/${org.id}/workspaces/${workspace.id}/documents`, { data: { title: "Elsewhere" } })).json());
    await elsewhere.goto(`/?user=${owner}&doc=${other.id}`);
    await expect(elsewhere.getByRole("status")).toHaveText("live");
    return elsewhereNode();
  }, { timeout: 60_000, intervals: [0] }).not.toBe(ownerNode());
  await elsewhere.context().close();

  // --- 4. The preview shows the running page and follows edits. (F13, F15)
  const preview = page.frameLocator("iframe[title='Preview of this page']");
  await button(page, "Preview").click();
  const converged = (await label(page).textContent())?.replace(/^label=/u, "") ?? "";
  await expect(preview.getByRole("button", { name: converged })).toBeVisible({ timeout: 120_000 });
  await layer(page, "Button 1").click();
  const edited = Date.now();
  await setLabel(page, "Pay now");
  await expect(preview.getByRole("button", { name: "Pay now" })).toBeVisible({ timeout: 3_000 });
  expect(Date.now() - edited).toBeLessThan(3_000);
  await button(page, "Preview").click();

  // --- 5. The AI: nodes stream onto both canvases while the editor edits; a run cancelled; a retried start; usage. (F9-F12, F27, F30, F31)
  const ask = async (instruction: string): Promise<void> => {
    await page.getByLabel("Ask the AI to change this page").fill(instruction);
    await button(page, "Ask the AI").click();
    await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "running");
  };
  const agentHere = (p: Page) => p.getByRole("list", { name: "Also here" }).getByRole("listitem").filter({ hasText: "agent" });
  const aiButtons = (p: Page) => p.locator("[data-component=Card] [data-component=Button]");
  await ask("a card with 6 buttons");
  await expect(agentHere(editor)).toHaveCount(1);
  await expect.poll(() => aiButtons(editor).count()).toBeGreaterThanOrEqual(1);
  expect(await aiButtons(editor).count()).toBeLessThan(6); // one by one
  await editor.reload(); // the run's progress survives a reload
  await expect(editor.getByRole("status")).toHaveText("live");
  await expect(editor.locator("#ai-status")).toHaveAttribute("data-run-status", "running");
  await layer(editor, "Page").click();
  await tile(editor, "Text").click(); // a person editing during the run
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "succeeded", { timeout: 20_000 });
  for (const each of [page, editor, watcher]) {
    await expect(aiButtons(each)).toHaveCount(6);
    await expect(texts(each)).toHaveCount(2);
    await expect(agentHere(each)).toHaveCount(0);
  }
  expect(await treeOf(editor)).toBe(await treeOf(page));

  await ask("a card with 30 buttons");
  await expect.poll(() => aiButtons(editor).count()).toBeGreaterThanOrEqual(8);
  const asked = Date.now();
  await button(page, "Cancel the AI run").click();
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "cancelled", { timeout: 3_000 });
  expect(Date.now() - asked).toBeLessThan(3_000);
  await expect(agentHere(editor)).toHaveCount(0);

  const retried = { data: { instruction: "a card with 0 buttons" }, headers: { "idempotency-key": `scenario-${stamp}` } };
  const first = await api.post(`/api/documents/${documentId}/runs`, retried);
  const again = await api.post(`/api/documents/${documentId}/runs`, retried);
  expect([first.status(), again.status()]).toEqual([201, 201]);
  const run = Run.parse(await first.json());
  expect(Run.parse(await again.json()).id).toBe(run.id); // the same job, not a second one
  await expect.poll(async () => Run.parse(await (await api.get(`/api/documents/${documentId}/runs/${run.id}`)).json()).status, { timeout: 20_000 }).toBe("succeeded");
  const usage = UsageReport.parse(await (await api.get(`/api/orgs/${org.id}/usage`)).json());
  expect(usage.totals.runs).toBeGreaterThanOrEqual(2);
  expect(usage.totals.inputTokens).toBe(usage.totals.runs * 1200); // the scripted model's count, per run
  expect(usage.byUser.map((row) => row.email)).toEqual([owner]);

  // --- 6. During an AI run, an engineer's in-shape push lands within 5 s; a shape-breaking one raises the banner. (F16a, F16b, F29)
  const before = (await welcomeOf(browser, viewerUrl)).doc;
  const buttonId = Object.values(before.nodes).find((node) => node.component === "Button" && node.parentId === before.rootId)?.id ?? "";
  const fromGit = relabel(before, buttonId, "From git");
  const aiBefore = await aiButtons(page).count();
  await ask("a card with 30 buttons");
  const pushedAt = Date.now();
  const pushed = await pushPage(documentId, pageOf(fromGit), "relabel the pay button", { base: pageOf(before) });
  try {
    await welcomeOf(browser, viewerUrl); // a new branch is found by the reconcile: opening the document asks for one
    await expect(label(page)).toHaveText("label=From git", { timeout: 5_000 });
    expect(Date.now() - pushedAt).toBeLessThan(5_000);
    await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "running"); // not starved by the run
    await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "succeeded", { timeout: 30_000 });
    await expect(page.locator("[data-component=Card]:has([data-component=Button])")).toHaveCount(3); // the push undid none of the AI's work
    for (const each of [page, editor]) await expect(aiButtons(each)).toHaveCount(aiBefore + 30);

    const broken = pageOf(fromGit).replace(/\{\n/u, "{\n  const [count] = useState(0);\n");
    const rejected = await pushPage(documentId, broken, "count clicks", { onBranch: true }); // the branch exists: the webhook tells the git peer
    const banner = page.getByRole("alert").filter({ hasText: rejected.commit });
    await expect(banner).toContainText(rejected.path, { timeout: 20_000 });
    await expect(label(page)).toHaveText("label=From git"); // nothing of it applied

    // --- 7. `kill -9` the node that owns the room mid-edit: the other node takes it; no acknowledged op lost or doubled. (F18, F19, F21)
    const victim = ownerNode();
    const survivor = victim === "3101" ? "3104" : "3101";
    await layer(page, "Page").click();
    for (let i = 0; i < 3; i++) await tile(page, "Text").click();
    await expect(page.getByText("saved", { exact: true })).toBeVisible(); // three acknowledged
    const textsBefore = await texts(page).count();
    const burst = [tile(editor, "Text").click(), tile(editor, "Text").click()];
    for (const pid of execFileSync("lsof", ["-nP", "-t", `-iTCP:${victim}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)) process.kill(Number(pid), "SIGKILL");
    await Promise.all(burst);
    for (let i = 0; i < 2; i++) await tile(page, "Text").click(); // made while no node has the room
    for (const [each, onNode] of [[page, ownerNode], [editor, editorNode], [watcher, undefined]] as const) {
      await expect(each.getByRole("status")).toHaveText("live", { timeout: 40_000 });
      if (onNode) expect(onNode()).toBe(survivor);
    }
    for (const each of [page, editor]) await expect(each.getByText("saved", { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const each of [page, editor, watcher]) await expect(texts(each)).toHaveCount(textsBefore + 4);
    expect(await treeOf(editor)).toBe(await treeOf(page));
    expect(await treeOf(watcher)).toBe(await treeOf(page));
    // A newcomer is welcomed by the survivor's room, rebuilt from the snapshot and the journal: the same tree.
    const recovered = (await welcomeOf(browser, viewerUrl)).doc;
    expect(Object.values(recovered.nodes).filter((node) => node.component === "Text")).toHaveLength(textsBefore + 4);
    expect(await treeOf(page)).toBe(await treeOf(watcher));

    // --- 9. Ship twice: one open pull request, its page byte-identical to a fresh codegen of the final document. (F13, F17)
    const status = page.locator("[data-ship-status]");
    await button(page, "Ship").click();
    await expect(status).toHaveAttribute("data-ship-status", "succeeded", { timeout: 60_000 });
    const pulls = await openPullsOf(documentId);
    expect(pulls).toHaveLength(1);
    await expect(page.getByRole("link", { name: `Pull request #${String(pulls[0]?.number)}`, exact: true })).toBeVisible();
    expect(await pageInGitea(documentId)).toBe(pageOf((await welcomeOf(browser, viewerUrl)).doc));
    await layer(page, "Page").click();
    await tile(page, "Button").click();
    await expect(page.getByText("saved", { exact: true })).toBeVisible();
    const final = pageOf((await welcomeOf(browser, viewerUrl)).doc);
    await button(page, "Ship").click();
    await expect.poll(() => pageInGitea(documentId), { timeout: 60_000 }).toBe(final);
    await expect(status).toHaveAttribute("data-ship-status", "succeeded", { timeout: 30_000 });
    expect((await openPullsOf(documentId)).map((pull) => pull.number)).toEqual(pulls.map((pull) => pull.number));
  } finally {
    await closePulls(documentId);
    await pushed.remove();
  }

  // --- 10. The outsider's share revoked: their page closes. The audit trail lists it all. (F25, F26)
  expect((await api.delete(`/api/documents/${documentId}/shares/${share.userId}`)).status()).toBe(204);
  await expect(editor.getByRole("alert")).toContainText("This document cannot be opened", { timeout: 10_000 });
  const audit = AuditPage.parse(await (await api.get(`/api/orgs/${org.id}/audit`)).json()).items.map((entry) => entry.action);
  expect(audit[0]).toBe("share_revoked");
  await page.goto("/");
  await page.getByRole("link", { name: `Audit trail of ${org.name}`, exact: true }).click();
  const rows = page.getByRole("table").locator("tbody tr");
  await expect(rows.first()).toContainText(`Revoked the share of ${outsider}.`);
  for (const [what, count] of [
    ["Signed in.", 1],
    [`Added ${viewer} as viewer.`, 1],
    [`Shared a document with ${outsider} as editor.`, 1],
    ["Started an AI run:", 4],
    [`A push to src/pages/noon-${documentId}.tsx was not applied.`, 1],
    ["Started a ship.", 2],
    [`Revoked the share of ${outsider}.`, 1],
  ] as const) await expect(rows.filter({ hasText: what }), what).toHaveCount(count);
});
