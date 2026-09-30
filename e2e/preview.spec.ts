import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// F15: the canvas shows the document's running page, it follows edits, and it survives its container.
// The sandbox worker under test is the REAL one (apps/worker/src/main.ts, WORKER_QUEUE=sandbox), in
// its own pool (playwright.config.ts), against real Docker.
const user = `e2e-${String(Date.now())}-preview@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const preview = (page: Page) => page.frameLocator("iframe[title='Preview of this page']");
const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin` } });

async function newDocument(page: Page): Promise<string> {
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  await button(page, "Show the running page").click();
  return new URL(page.url()).searchParams.get("doc") ?? "";
}
async function labelButton(page: Page, label: string): Promise<void> {
  await page.getByLabel("label", { exact: true }).fill(label);
  await page.getByLabel("label", { exact: true }).blur();
}

// A cold sandbox (first clone, first Vite transform) can take a while on a busy machine; the 3 s is
// measured from the EDIT, once the preview is up.
test.setTimeout(120_000);

test("the preview follows an edit within 3 s, without reloading the page", async ({ page, baseURL }) => {
  const documentId = await newDocument(page);
  await button(page, "Add Button").click();
  await layer(page, "Button 1").click();
  await labelButton(page, "First");
  await expect(preview(page).getByRole("button", { name: "First" })).toBeVisible({ timeout: 90_000 });
  // An opaque origin: scripts run, but never as 127.0.0.1 (no allow-same-origin: storage a preview left
  // on a reused port is not another's to read).
  await expect(page.locator("iframe[title='Preview of this page']")).toHaveAttribute("sandbox", "allow-scripts");
  // Through the canvas's own origin, as a visitor behind a tunnel gets it (noon-l96): page, modules, and
  // the HMR socket the edit below arrives on all pass the dev server's /preview/ proxy.
  await expect(page.locator("iframe[title='Preview of this page']")).toHaveAttribute("src", new RegExp(`^${baseURL ?? ""}/preview/${documentId}/[0-9a-f]{16}\\.[0-9a-f]{32}/noon-preview/`, "u"));
  // Marks THIS page load. A full reload (or a new iframe) would lose it.
  await preview(page).locator("body").evaluate(() => { (window as unknown as { noonMark: string }).noonMark = "same load"; });

  const edited = Date.now();
  await labelButton(page, "Second");
  await expect(preview(page).getByRole("button", { name: "Second" })).toBeVisible({ timeout: 3_000 });
  expect(Date.now() - edited).toBeLessThan(3_000);
  expect(await preview(page).locator("body").evaluate(() => (window as unknown as { noonMark?: string }).noonMark)).toBe("same load");
});

test.describe("when the container dies", () => {
  // The dead dev server, seen from inside the preview: its lost connection, and Vite's reconnect code
  // failing in the opaque-origin frame (a SharedWorker is refused to origin "null"; the canvas loads the
  // new address itself instead). Expected here, nowhere else.
  test.use({ allowedConsole: /ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|Failed to load resource|\[vite\]|SharedWorker/u });

  test("the preview says it is rebuilding, and comes back with the document on its own", async ({ page }) => {
    const documentId = await newDocument(page);
    await button(page, "Add Button").click();
    await layer(page, "Button 1").click();
    // Something a FRESH container would not show (it starts from an empty page): if the preview
    // below shows it, the new container really was given the document, not merely started.
    await labelButton(page, "Survives");
    await expect(preview(page).getByRole("button", { name: "Survives" })).toBeVisible({ timeout: 90_000 });

    docker("rm", "--force", `noon-sandbox-${documentId}`);
    await expect(page.getByText("Rebuilding the preview…")).toBeVisible({ timeout: 10_000 });
    await expect(preview(page).getByRole("button", { name: "Survives" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Rebuilding the preview…")).toBeHidden();
  });
});
