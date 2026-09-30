import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import type { Page } from "@playwright/test";
import type { Doc } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { generate } from "../packages/codegen/src/index.ts";
import { expect } from "./fixtures.ts";

// Both sides of an F16 test: the canvas's document, and an engineer's push to the dev stack's REAL Gitea (one
// commit on the document's branch, `noon/<id>`, that writes its generated page). Only the one key this needs
// leaves .env, and it goes to git as a header, never into a URL or a log.
const exec = promisify(execFile);
const TOKEN = parseEnv(readFileSync(".env", "utf8"))["GITEA_TOKEN"] ?? "";
const REPO = `http://127.0.0.1:${process.env["GITEA_PORT"] ?? "3002"}/noon/sample-app.git`;
const gitEnv = {
  ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "eng", GIT_AUTHOR_EMAIL: "eng@localhost", GIT_COMMITTER_NAME: "eng", GIT_COMMITTER_EMAIL: "eng@localhost",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`noon:${TOKEN}`).toString("base64")}`,
};
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd, env: gitEnv })).stdout.trim();

/** Pushes `tsx` as the document's page. `remove` deletes the branch again and the local clone: call it in `finally`. */
export async function pushPage(documentId: string, tsx: string, message: string): Promise<{ commit: string; path: string; remove: () => Promise<void> }> {
  const work = mkdtempSync(join(tmpdir(), "noon-e2e-push-"));
  const branch = `refs/heads/noon/${documentId}`;
  const path = `src/pages/noon-${documentId}.tsx`;
  const remove = async (): Promise<void> => {
    await git(work, "push", "--quiet", "--", REPO, `:${branch}`).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  };
  try {
    await git(work, "init", "--quiet");
    await git(work, "fetch", "--quiet", "--depth=1", "--", REPO, "main");
    await git(work, "checkout", "--quiet", "FETCH_HEAD");
    mkdirSync(join(work, "src/pages"), { recursive: true });
    writeFileSync(join(work, path), tsx);
    await git(work, "add", "--all");
    await git(work, "commit", "--quiet", "-m", message);
    await git(work, "push", "--quiet", "--", REPO, `HEAD:${branch}`);
    return { commit: await git(work, "rev-parse", "HEAD"), path, remove };
  } catch (problem) {
    await remove();
    throw problem;
  }
}

/** A new document holding one Button, saved; `frames` collects every frame the canvas receives from then on. */
export async function documentWithButton(page: Page, user: string): Promise<{ documentId: string; buttonId: string; frames: string[] }> {
  const frames: string[] = [];
  page.on("websocket", (ws) => { ws.on("framereceived", (frame) => { if (typeof frame.payload === "string") frames.push(frame.payload); }); });
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  await page.getByRole("button", { name: "Add Button", exact: true }).click();
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  const documentId = new URL(page.url()).searchParams.get("doc") ?? "";
  const buttonId = (await page.locator("[data-component=Button]").getAttribute("data-node-id")) ?? "";
  return { documentId, buttonId, frames };
}

/** The engineer's edit: the document's generated page with its one button relabelled. */
export function relabelled(buttonId: string, label: string): string {
  const edited: Doc = {
    rootId: "root",
    nodes: {
      root: { id: "root", component: "Page", props: {}, parentId: null, children: [buttonId] },
      [buttonId]: { id: buttonId, component: "Button", props: { label }, parentId: "root", children: [] },
    },
  };
  const file = generate(edited, manifest);
  if (!file.ok) throw new Error(file.reason);
  return file.tsx;
}
