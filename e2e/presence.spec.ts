import { expect, test } from "./fixtures.ts";

// F7: names, cursors and selections of the others; gone within 5 s of a closed tab.
const user = `e2e-${String(Date.now())}-presence@example.com`;

test("each browser sees the other's name, pointer and selection, and forgets a closed tab within 5 s", async ({ page, browser }) => {
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  await page.getByRole("button", { name: "Add Card", exact: true }).click();

  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");
  const here = page.getByRole("list", { name: "Also here" }).getByRole("listitem");
  await expect(here).toHaveCount(1); // the other browser, known from the moment it joined
  await expect(here).toContainText("e2e-"); // the name the API vouches for, not one the client chose

  // The other browser selects the card, then rests its pointer in the middle of its canvas
  // (in that order: the click itself moves the pointer to the button).
  await other.getByRole("button", { name: "Select Card 1", exact: true }).click();
  const box = await other.getByRole("region", { name: "Canvas" }).boundingBox();
  if (!box) throw new Error("no canvas");
  await other.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const cursor = page.locator("[data-presence-cursor]");
  await expect(cursor).toHaveCount(1);
  await expect(page.locator("[data-component=Card][data-selected-by]")).toHaveCount(1);
  // The pointer is shown at the same FRACTION of this canvas (the two windows need not be the same size).
  const mine = await page.getByRole("region", { name: "Canvas" }).boundingBox();
  if (!mine) throw new Error("no canvas");
  await expect.poll(async () => { const dot = await cursor.boundingBox(); return dot ? Math.abs((dot.x - mine.x) / mine.width - 0.5) : 1; }).toBeLessThan(0.05);

  // Nothing of this is part of the document.
  await expect(page.getByText("saved", { exact: true })).toBeVisible();

  const closedAt = Date.now();
  await other.close();
  await expect(here).toHaveCount(0, { timeout: 5000 });
  await expect(cursor).toHaveCount(0);
  await expect(page.locator("[data-selected-by]")).toHaveCount(0);
  expect(Date.now() - closedAt).toBeLessThan(5000);
});
