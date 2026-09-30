import { expect, test } from "./fixtures.ts";

// F7: names, cursors and selections of the others; gone within 5 s of a closed tab.
const user = `e2e-${String(Date.now())}-presence@example.com`;

test("each browser sees the other's name, pointer and selection, and forgets a closed tab within 5 s", async ({ page, browser }) => {
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  await page.getByRole("option", { name: "Card", exact: true }).click();

  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");
  const here = page.getByRole("list", { name: "Also here" }).getByRole("listitem");
  await expect(here).toHaveCount(1); // the other browser, known from the moment it joined
  await expect(here).toContainText("e2e-"); // the name the API vouches for, not one the client chose

  // The other browser selects the card, then rests its pointer in the middle of the card on ITS canvas
  // (in that order: the click itself moves the pointer to the button).
  await other.getByRole("treeitem", { name: "Card 1", exact: true }).click();
  const theirCard = await other.locator("[data-node-id][data-component=Card] > :first-child").boundingBox();
  if (!theirCard) throw new Error("no card");
  await other.mouse.move(theirCard.x + theirCard.width / 2, theirCard.y + theirCard.height / 2);

  const cursor = page.locator("[data-presence-cursor]");
  await expect(cursor).toHaveCount(1);
  await expect(page.locator("[data-component=Card][data-selected-by]")).toHaveCount(1);
  // The pointer travels in the frame's own coordinates (E10.6), so here it is drawn on OUR card, whatever the window sizes.
  const myCard = await page.locator("[data-node-id][data-component=Card] > :first-child").boundingBox();
  if (!myCard) throw new Error("no card");
  await expect.poll(async () => { const tip = await cursor.boundingBox(); return tip !== null && tip.x > myCard.x && tip.x < myCard.x + myCard.width && tip.y > myCard.y && tip.y < myCard.y + myCard.height; }).toBe(true);

  // Nothing of this is part of the document.
  await expect(page.getByText("saved", { exact: true })).toBeVisible();

  const closedAt = Date.now();
  await other.close();
  await expect(here).toHaveCount(0, { timeout: 5000 });
  await expect(cursor).toHaveCount(0);
  await expect(page.locator("[data-selected-by]")).toHaveCount(0);
  expect(Date.now() - closedAt).toBeLessThan(5000);
});
