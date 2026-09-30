import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import type { Doc } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { generate } from "../packages/codegen/src/index.ts";
import { expect, test } from "./fixtures.ts";

// e2e:push-updates-canvas (F16a). An engineer pushes an edit of the generated page to the dev stack's REAL
// Gitea; the REAL git peer (apps/worker/src/main.ts, WORKER_QUEUE=git, from source: playwright.config.ts)
// turns it into ops through peer-client, and the open canvas shows them without a reload.
const user = `e2e-${String(Date.now())}-push@example.com`;
const exec = promisify(execFile);
// Only the one key this test needs leaves .env, and it goes to git as a header, never into a URL or a log.
const TOKEN = parseEnv(readFileSync(".env", "utf8"))["GITEA_TOKEN"] ?? "";
const REPO = `http://127.0.0.1:${process.env["GITEA_PORT"] ?? "3002"}/noon/sample-app.git`;
const gitEnv = {
  ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "eng", GIT_AUTHOR_EMAIL: "eng@localhost", GIT_COMMITTER_NAME: "eng", GIT_COMMITTER_EMAIL: "eng@localhost",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`noon:${TOKEN}`).toString("base64")}`,
};
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd, env: gitEnv })).stdout.trim();

test.setTimeout(60_000);

test("a push that edits the page's generated file changes the open canvas, as git, without a reload", async ({ page, browser }) => {
  // Every frame the canvas receives: the ops must arrive stamped by the room as the git peer's.
  const frames: string[] = [];
  page.on("websocket", (ws) => { ws.on("framereceived", (frame) => { if (typeof frame.payload === "string") frames.push(frame.payload); }); });
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  await page.getByRole("button", { name: "Add Button", exact: true }).click();
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  const documentId = new URL(page.url()).searchParams.get("doc") ?? "";
  const buttonId = (await page.locator("[data-component=Button]").getAttribute("data-node-id")) ?? "";
  await page.evaluate(() => { (window as unknown as { noonMark: string }).noonMark = "same load"; }); // a reload would lose it

  // The engineer's edit: the document's page with the button relabelled, committed on the document's branch.
  const edited: Doc = {
    rootId: "root",
    nodes: {
      root: { id: "root", component: "Page", props: {}, parentId: null, children: [buttonId] },
      [buttonId]: { id: buttonId, component: "Button", props: { label: "From git" }, parentId: "root", children: [] },
    },
  };
  const file = generate(edited, manifest);
  if (!file.ok) throw new Error(file.reason);
  const work = mkdtempSync(join(tmpdir(), "noon-e2e-push-"));
  const branch = `refs/heads/noon/${documentId}`;
  try {
    await git(work, "init", "--quiet");
    await git(work, "fetch", "--quiet", "--depth=1", "--", REPO, "main");
    await git(work, "checkout", "--quiet", "FETCH_HEAD");
    mkdirSync(join(work, "src/pages"), { recursive: true });
    writeFileSync(join(work, `src/pages/noon-${documentId}.tsx`), file.tsx);
    await git(work, "add", "--all");
    await git(work, "commit", "--quiet", "-m", "relabel the button");
    await git(work, "push", "--quiet", "--", REPO, `HEAD:${branch}`);
    // A new branch is found by the reconcile (the webhook ignores it): opening the document asks for one now.
    const other = await (await browser.newContext()).newPage();
    await other.goto(page.url());
    await expect(other.getByRole("status")).toHaveText("live");

    await expect(page.locator("[data-component=Button] > .node-props")).toHaveText("label=From git", { timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { noonMark?: string }).noonMark)).toBe("same load");
    const ops = frames.map((f) => JSON.parse(f) as { type: string; actor?: { kind: string; runId?: string }; op?: unknown });
    expect(ops.filter((m) => m.type === "op" && m.actor?.kind === "git")).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ kind: "git", runId: await git(work, "rev-parse", "HEAD") }), op: { type: "set_prop", nodeId: buttonId, key: "label", value: "From git" } }),
    ]);
  } finally {
    await git(work, "push", "--quiet", "--", REPO, `:${branch}`).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
});
