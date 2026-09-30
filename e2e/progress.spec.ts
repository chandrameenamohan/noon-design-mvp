import { expect, test } from "./fixtures.ts";

// F30. The model is scripted (e2e/stub-worker.ts: a Card, then a Button every 400 ms); the steps travel the real way:
// the worker's tools -> the job's row -> the api -> the panel's poll, through the same /api the ngrok host proxies.
const user = `e2e-${String(Date.now())}-progress@example.com`;

// e2e:progress-survives-reload
test("the run's steps and status stream to the browser, and a reload mid-run picks the same run up and follows it to the end", async ({ page }) => {
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  await page.getByLabel("Ask the AI to change this page").fill("a card with 8 buttons");
  await page.getByRole("button", { name: "Ask the AI", exact: true }).click();

  const steps = page.getByRole("list", { name: "What the AI has done" }).getByRole("listitem");
  await expect(steps.first()).toHaveText("Added Card");
  await expect.poll(() => steps.count()).toBeGreaterThanOrEqual(3); // streaming: steps arrive while it runs
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "running");
  const before = await steps.count();
  expect(before).toBeLessThan(9);

  await page.reload();
  await expect(page.getByRole("status")).toHaveText("live");
  // The same run, still running, with every step it had taken: none lost, none from anywhere else.
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "running");
  await expect.poll(() => steps.count()).toBeGreaterThanOrEqual(before);
  await expect(steps.first()).toHaveText("Added Card");
  await expect(page.getByRole("button", { name: "Cancel the AI run", exact: true })).toBeVisible(); // and it can still be stopped
  await expect(page.getByRole("button", { name: "Ask the AI", exact: true })).toBeDisabled();

  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "succeeded", { timeout: 15_000 });
  await expect(steps).toHaveCount(9);
  await expect(steps.nth(8)).toHaveText("Added Button");
  await expect(page.locator("[data-component=Card] [data-component=Button]")).toHaveCount(8);

  // After the end, a reload still says what the run did.
  await page.reload();
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "succeeded");
  await expect(steps).toHaveCount(9);
});
