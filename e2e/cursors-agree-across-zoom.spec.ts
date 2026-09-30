import type { Page } from "@playwright/test";
import { axeClean, box, button, centreOf, emptySpot, heading, layer, newDocument, tile, zoomOf } from "./editor.ts";
import { expect, test } from "./fixtures.ts";

// e2e:cursors-agree-across-zoom (E10.6): two browsers at different zooms see each other's pointer on the same
// component, a still pointer fades after 5 s, an avatar in the bar jumps to that person's selection, and the
// frame's fields keep the design system's own light look in the dark theme (E10.5 hand-off).
const user = `e2e-${String(Date.now())}-cursors@example.com`;
/** How far the cursor's tip (its top-left corner) is from a screen point, in px. */
const tipDistance = async (page: Page, from: { x: number; y: number }): Promise<number> => {
  const tip = await page.locator("[data-presence-cursor]").first().boundingBox();
  return tip ? Math.hypot(tip.x - from.x, tip.y - from.y) : Number.POSITIVE_INFINITY;
};

test("a pointer rests on the Button in one browser and is drawn on the Button in the other, at a different zoom and after either side zooms; still 5 s, it fades; the avatar jumps to that person's selection", async ({ page, browser }) => {
  await newDocument(page, user);
  await tile(page, "Card").click();
  await layer(page, "Card 1").click();
  await tile(page, "Button").click(); // into the card
  await expect(page.locator("[data-node-id][data-component=Button]")).toHaveCount(1);

  const other = await (await browser.newContext({ viewport: { width: 1100, height: 640 } })).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");
  await expect(other.locator("[data-node-id][data-component=Button]")).toHaveCount(1);

  // The other browser zooms out twice, so the two frames are drawn at different sizes and offsets.
  const theirSpot = await emptySpot(other);
  await other.mouse.click(theirSpot.x, theirSpot.y);
  await other.keyboard.press("-");
  await other.keyboard.press("-");
  expect(await zoomOf(other)).toBeLessThan((await zoomOf(page)) * 0.9);
  // It selects the Button, then rests its pointer in the middle of it (in that order: the click moves the pointer).
  await other.getByRole("treeitem", { name: "Button 1", exact: true }).click();
  const theirButton = await centreOf(other, "Button");
  await other.mouse.move(theirButton.x, theirButton.y);

  // Here the cursor is drawn on OUR Button, in OUR frame: the same world point at a different zoom.
  const cursor = page.locator("[data-presence-cursor]");
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toContainText("e2e-"); // the tag is the name the api vouches for
  await expect(cursor).toHaveAttribute("data-actor-kind", "user");
  const myButton = await centreOf(page, "Button");
  await expect.poll(() => tipDistance(page, myButton)).toBeLessThan(4);
  // The cursor is decoration: the layer it sits in is hidden from assistive technology...
  await expect(cursor.locator("xpath=ancestor::*[@aria-hidden='true']")).toHaveCount(1);
  // ...and the record of who is here is the bar: the avatar names the person and their selection.
  const avatar = page.getByRole("list", { name: "Also here" }).getByRole("button");
  await expect(avatar).toHaveCount(1);
  await expect(avatar).toHaveAccessibleName(/e2e-.*Button 1/u);

  // WE zoom in: the cursor stays on the Button, moved by CSS alone (nothing was sent again). One press is one
  // step of x1.25 from wherever the page was fitted (about 68 % in a 1280 px window, not 100 %).
  const mySpot = await emptySpot(page);
  await page.mouse.click(mySpot.x, mySpot.y);
  const fitted = await zoomOf(page);
  await page.keyboard.press("+");
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(fitted * 1.2);
  const zoomedButton = await centreOf(page, "Button");
  expect(zoomedButton.x).not.toBeCloseTo(myButton.x, 0);
  await expect.poll(() => tipDistance(page, zoomedButton)).toBeLessThan(4);
  // The glyph and the tag keep their screen size at every zoom.
  const glyph = await box(page, "[data-presence-cursor] .cursor-glyph");
  expect(glyph.width).toBeGreaterThan(14);
  expect(glyph.width).toBeLessThan(18);

  // Still for 5 s: it fades. A move brings it back.
  await expect(cursor).toHaveAttribute("data-idle", "", { timeout: 8000 });
  await expect.poll(() => cursor.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  await other.mouse.move(theirButton.x + 10, theirButton.y + 4);
  await expect(cursor).not.toHaveAttribute("data-idle", "");
  await expect.poll(() => cursor.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

  // The avatar jumps to their selection: ours becomes the Button, and the canvas centres on it.
  await page.keyboard.press("Escape");
  await expect(heading(page)).toHaveText("Page");
  await avatar.click();
  await expect(heading(page)).toHaveText("Button 1");
  await expect(layer(page, "Button 1")).toHaveAttribute("aria-selected", "true");
  const canvas = await box(page, ".canvas");
  const centred = await centreOf(page, "Button");
  expect(Math.abs(centred.x - (canvas.x + canvas.width / 2))).toBeLessThan(3);
  expect(Math.abs(centred.y - (canvas.y + canvas.height / 2))).toBeLessThan(3);
  // Nothing of this touched the document.
  await expect(page.getByText("saved", { exact: true })).toBeVisible();

  // The other browser leaves: its cursor and avatar go within 5 s.
  await other.close();
  await expect(cursor).toHaveCount(0, { timeout: 6000 });
  await expect(avatar).toHaveCount(0);
});

test("the frame's Input renders on the design system's white in the dark theme too, and the bar and sheet are axe-clean in both themes", async ({ page, browser }) => {
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  await tile(page, "Input").click();
  const field = page.locator(".page-frame .ds-input input");
  await expect(field).toHaveCount(1);
  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");
  const mine = await box(page, ".canvas");
  await other.mouse.move(mine.x + mine.width / 2, mine.y + mine.height / 2);
  await expect(page.locator("[data-presence-cursor]")).toHaveCount(1);
  await axeClean(page, "light");

  await button(page, "Dark theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // The editor's own `input` rule reaches into the frame, but resolves to the design system's palette there.
  expect(await field.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  expect(await field.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(22, 24, 29)");
  await expect(page.locator("[data-presence-cursor]")).toHaveCount(1);
  await axeClean(page, "dark");
  await other.close();
});
