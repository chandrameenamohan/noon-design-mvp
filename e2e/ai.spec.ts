import { twoBrowsersOnANewDocument } from "./editor.ts";
import { expect, test } from "./fixtures.ts";

// F9, F10, F11. The model is scripted (e2e/stub-worker.ts); everything else is the real thing: the api,
// the queue, the worker's handler, peer-client, the sync server and two browsers.
const user = `e2e-${String(Date.now())}-ai@example.com`;

// e2e:ai-run-streams
test("an instruction makes the AI appear, its nodes arrive on BOTH canvases one by one while a person edits too, and the run ends `succeeded`", async ({ page, browser }) => {
  const other = await twoBrowsersOnANewDocument(page, browser, user);
  await page.getByLabel("Ask the AI to change this page").fill("a card with 4 buttons");
  await page.getByRole("button", { name: "Ask the AI", exact: true }).click();

  // The AI is a peer: it shows among the people here, by its kind (it has no name of its own).
  await expect(page.getByRole("list", { name: "Also here" }).getByRole("listitem").filter({ hasText: "agent" })).toHaveCount(1);
  await expect(other.getByRole("list", { name: "Also here" }).getByRole("listitem").filter({ hasText: "agent" })).toHaveCount(1);
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "running");

  // One by one: the second button is there while the fourth is not yet.
  const aiButtons = other.locator("[data-component=Button]");
  // (never wait for EXACTLY two: a poll can look before and after that moment and miss it)
  await expect.poll(() => aiButtons.count()).toBeGreaterThanOrEqual(1);
  expect(await aiButtons.count()).toBeLessThan(4);
  // A person edits during the run: an ordinary concurrent edit (F11).
  await other.getByRole("option", { name: "Text", exact: true }).click();

  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "succeeded", { timeout: 15_000 });
  await expect(page.locator("#ai-status")).toHaveText("The AI has finished.");
  for (const each of [page, other]) {
    await expect(each.locator("[data-component=Card]")).toHaveCount(1);
    await expect(each.locator("[data-component=Card] [data-component=Button]")).toHaveCount(4);
    await expect(each.locator("[data-component=Text]")).toHaveCount(1);
    await expect(each.getByRole("list", { name: "Also here" }).getByRole("listitem").filter({ hasText: "agent" })).toHaveCount(0); // it has left
  }
  // Both browsers hold the same tree, in the same order.
  const tree = (p: typeof page) => p.locator("[data-node-id]").evaluateAll((nodes) => nodes.map((n) => `${n.getAttribute("data-component") ?? ""}:${n.getAttribute("data-node-id") ?? ""}`));
  expect(await tree(other)).toEqual(await tree(page));
});

// e2e:ai-cancel-within-3s
test("cancel ends the run within 3 s: what the AI had already made stays, nothing more arrives, and the AI leaves", async ({ page, browser }) => {
  const other = await twoBrowsersOnANewDocument(page, browser, user);
  await page.getByLabel("Ask the AI to change this page").fill("a card with 30 buttons");
  await page.getByRole("button", { name: "Ask the AI", exact: true }).click();
  const made = other.locator("[data-component=Button]");
  await expect.poll(() => made.count()).toBeGreaterThanOrEqual(2);

  // While it runs, a second run on the same document is refused, in words.
  await expect(page.getByRole("button", { name: "Ask the AI", exact: true })).toBeDisabled();

  const asked = Date.now();
  await page.getByRole("button", { name: "Cancel the AI run", exact: true }).click();
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "cancelled", { timeout: 3000 });
  expect(Date.now() - asked).toBeLessThan(3000);
  await expect(page.locator("#ai-status")).toContainText("already changed stays");
  await expect(other.getByRole("list", { name: "Also here" }).getByRole("listitem").filter({ hasText: "agent" })).toHaveCount(0);

  const kept = await made.count();
  expect(kept).toBeGreaterThanOrEqual(2);
  expect(kept).toBeLessThan(30);
  await page.waitForTimeout(1200); // three more would have arrived by now
  expect(await made.count()).toBe(kept);
  await expect(page.locator("[data-component=Button]")).toHaveCount(kept);
  await expect(page.getByRole("button", { name: "Cancel the AI run", exact: true })).toHaveCount(0);
});

test("a run the provider refuses fails fast with its reason in words, and the page is unchanged", async ({ page }) => {
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  await page.getByLabel("Ask the AI to change this page").fill("please hit the rate limit");
  await page.getByRole("button", { name: "Ask the AI", exact: true }).click();
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "failed", { timeout: 10_000 });
  await expect(page.locator("#ai-status")).toContainText("limiting requests");
  await expect(page.locator("[data-node-id]")).toHaveCount(1); // only the page itself
});
