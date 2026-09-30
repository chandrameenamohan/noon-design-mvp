import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// e2e:canvas-zoom-pan-select (E10.2): the real components on an infinite canvas; zoom at the pointer, pan,
// click and keyboard selection with an outline and a label; the frame is inert; axe-clean in both themes.
const user = `e2e-${String(Date.now())}-zoom@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A component in the library (E10.5): a click adds it into the selection, as the "Add X" buttons did. */
const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const canvasOf = (page: Page) => page.getByRole("region", { name: "Canvas" });
const heading = (page: Page) => page.getByRole("complementary", { name: "Selected element" }).getByRole("heading");
const zoomOf = async (page: Page): Promise<number> => Number(await page.locator(".world").getAttribute("data-zoom"));
const box = async (page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
};
/** The middle of a node's own element (its wrapper has no box): where a person would click it. */
const centreOf = async (page: Page, component: string): Promise<{ x: number; y: number }> => {
  const b = await box(page, `[data-node-id][data-component=${component}] > :first-child`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** A spot on the sheet with nothing on it: the fitted frame leaves a margin, and its top-left corner is outside the frame. */
const emptySpot = async (page: Page): Promise<{ x: number; y: number }> => { const c = await box(page, ".canvas"); return { x: c.x + 12, y: c.y + 12 }; };
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};

async function pageWithCardButtonText(page: Page): Promise<void> {
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  await tile(page, "Card").click();
  await layer(page, "Card 1").click();
  await tile(page, "Button").click(); // into the card
  await tile(page, "Text").click(); // into the card, after the button
  await expect(page.locator("[data-node-id][data-component=Card] [data-node-id]")).toHaveCount(2);
}

test("the REAL components render, inert, in a page frame; click selects the node under the pointer with an outline and its label; hover outlines; Escape selects the page", async ({ page }) => {
  await pageWithCardButtonText(page);

  // The sample app's own Button and Text, not wireframes: their classes come from the design system.
  await expect(page.locator("[data-node-id][data-component=Button] > button.ds-button")).toHaveText("Button");
  // ...and on the canvas `data-component` names nodes only: the components' own marker is taken off.
  await expect(page.locator("[data-component=Button]")).toHaveCount(1);
  await expect(page.locator("[data-node-id][data-component=Text] > p.ds-text")).toHaveText("Text");
  await expect(page.locator("[data-node-id][data-component=Card] > section.ds-card")).toBeVisible();
  await expect(page.locator(".page-frame")).toHaveAttribute("inert", "");

  // Click the Button: the node is selected, the real button is not pressed and does not take focus.
  await page.evaluate(() => { document.querySelectorAll(".ds-button").forEach((b) => { b.addEventListener("click", () => { document.body.dataset["dsClicked"] = "yes"; }); }); });
  const at = await centreOf(page, "Button");
  await page.mouse.click(at.x, at.y);
  await expect(heading(page)).toHaveText("Button 1");
  await expect(page.locator("[data-outline=selected]")).toHaveText("Button 1");
  await expect(layer(page, "Button 1")).toHaveAttribute("aria-selected", "true");
  await expect(canvasOf(page)).toBeFocused();
  expect(await page.evaluate(() => document.body.dataset["dsClicked"] ?? "no")).toBe("no");
  // The outline sits on the button's own box.
  const outline = await box(page, "[data-outline=selected]");
  const real = await box(page, "[data-node-id][data-component=Button] > button.ds-button");
  expect(Math.abs(outline.x - real.x)).toBeLessThan(2);
  expect(Math.abs(outline.width - real.width)).toBeLessThan(2);

  // Hover names what a click would pick, without selecting it.
  const text = await centreOf(page, "Text");
  await page.mouse.move(text.x, text.y);
  await expect(page.locator("[data-outline=hovered]")).toHaveText("Text 1");
  await expect(heading(page)).toHaveText("Button 1");

  // Inside the card but beside its children: the card. On the empty sheet: the page. Escape: the page.
  const card = await box(page, "[data-node-id][data-component=Card] > section.ds-card");
  await page.mouse.click(card.x + card.width - 6, card.y + card.height - 6);
  await expect(heading(page)).toHaveText("Card 1");
  const empty = await emptySpot(page);
  await page.mouse.click(empty.x, empty.y);
  await expect(heading(page)).toHaveText("Page");
  await page.mouse.click(at.x, at.y);
  await expect(heading(page)).toHaveText("Button 1");
  await page.keyboard.press("Escape");
  await expect(heading(page)).toHaveText("Page");
  await expect(page.locator("[data-outline=selected]")).toHaveText("Page");
});

test("zoom: ctrl+wheel about the pointer, + and - about the centre, 0 and Fit refit, clamped to 10-400 %, with a readout", async ({ page }) => {
  await pageWithCardButtonText(page);
  const canvas = canvasOf(page);
  const empty = await emptySpot(page);
  await page.mouse.click(empty.x, empty.y); // focus the canvas
  const fitted = await zoomOf(page);
  expect(fitted).toBeGreaterThan(0.1);
  await expect(page.locator(".zoom-level")).toHaveText(`${String(Math.round(fitted * 100))}%`);

  // ctrl+wheel at the Button: zooms in, and the world point under the pointer stays put.
  const at = await centreOf(page, "Button");
  const frameBefore = await box(page, ".page-frame");
  const worldBefore = { x: (at.x - frameBefore.x) / fitted, y: (at.y - frameBefore.y) / fitted };
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(fitted * 1.3);
  const zoomed = await zoomOf(page);
  const frameAfter = await box(page, ".page-frame");
  expect(Math.abs((at.x - frameAfter.x) / zoomed - worldBefore.x)).toBeLessThan(2);
  expect(Math.abs((at.y - frameAfter.y) / zoomed - worldBefore.y)).toBeLessThan(2);
  // The selection outline is still 2 px on the screen, whatever the zoom.
  await expect(page.locator("[data-outline=selected]")).toHaveText("Page");
  const stroke = await page.locator("[data-outline=selected]").evaluate((el, z) => parseFloat(getComputedStyle(el).boxShadow.split(" ").at(-1) ?? "0") * z, zoomed);
  expect(Math.abs(stroke - 2)).toBeLessThan(0.2);

  // Keys: 0 refits, + and - step, and the readout follows.
  await page.keyboard.press("0");
  await expect.poll(() => zoomOf(page)).toBe(fitted);
  await page.keyboard.press("+");
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(fitted);
  await page.keyboard.press("-");
  await page.keyboard.press("-");
  await expect.poll(() => zoomOf(page)).toBeLessThan(fitted);
  await expect(page.locator(".zoom-level")).toHaveText(`${String(Math.round((await zoomOf(page)) * 100))}%`);

  // Clamped both ways.
  for (let i = 0; i < 20; i++) await page.keyboard.press("+");
  await expect(page.locator(".zoom-level")).toHaveText("400%");
  expect(await zoomOf(page)).toBe(4);
  for (let i = 0; i < 30; i++) await page.keyboard.press("-");
  await expect(page.locator(".zoom-level")).toHaveText("10%");
  expect(await zoomOf(page)).toBe(0.1);

  // The bar does the same by mouse.
  await button(page, "Zoom in").click();
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(0.1);
  await button(page, "Fit").click();
  await expect.poll(() => zoomOf(page)).toBe(fitted);
  await button(page, "Zoom out").click();
  await expect.poll(() => zoomOf(page)).toBeLessThan(fitted);
  await expect(canvas).toBeVisible();
});

test("pan: wheel, Space+drag and middle-drag move the sheet; a drag is not a click", async ({ page }) => {
  await pageWithCardButtonText(page);
  const canvas = canvasOf(page);
  const empty = await emptySpot(page);
  await page.mouse.click(empty.x, empty.y);
  await expect(heading(page)).toHaveText("Page");

  // A plain wheel (a trackpad's two fingers) pans by the delta.
  let before = await box(page, ".page-frame");
  await page.mouse.move(empty.x + 40, empty.y + 40);
  await page.mouse.wheel(50, 30);
  await expect.poll(async () => (await box(page, ".page-frame")).x).toBeCloseTo(before.x - 50, 0);
  expect((await box(page, ".page-frame")).y).toBeCloseTo(before.y - 30, 0);

  // Space held: the cursor says so, and the left button drags the sheet instead of selecting.
  await layer(page, "Button 1").click();
  await page.mouse.click(empty.x, empty.y); // focus the canvas again (this click selects the page)
  await layer(page, "Button 1").click();
  await canvas.focus();
  before = await box(page, ".page-frame");
  const at = await centreOf(page, "Button");
  await page.keyboard.down("Space");
  await expect(canvas).toHaveAttribute("data-panning", "ready");
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 80, at.y + 40, { steps: 4 });
  await expect(canvas).toHaveAttribute("data-panning", "dragging");
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(canvas).not.toHaveAttribute("data-panning", /.+/);
  expect((await box(page, ".page-frame")).x).toBeCloseTo(before.x + 80, 0);
  expect((await box(page, ".page-frame")).y).toBeCloseTo(before.y + 40, 0);
  await expect(heading(page)).toHaveText("Button 1"); // the drag started on the button and selected nothing

  // The middle button drags without Space.
  before = await box(page, ".page-frame");
  await page.mouse.move(empty.x + 20, empty.y + 20);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(empty.x - 30, empty.y + 60, { steps: 3 });
  await page.mouse.up({ button: "middle" });
  expect((await box(page, ".page-frame")).x).toBeCloseTo(before.x - 50, 0);
  expect((await box(page, ".page-frame")).y).toBeCloseTo(before.y + 40, 0);
  await expect(heading(page)).toHaveText("Button 1");
});

test("keyboard selection: arrows walk siblings, Enter goes in, Shift+Enter out; the canvas shows a focus ring and says what is selected; axe-clean light and dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await pageWithCardButtonText(page);
  const canvas = canvasOf(page);
  const empty = await emptySpot(page);
  await page.mouse.click(empty.x, empty.y);
  await expect(canvas).toBeFocused();
  await expect(heading(page)).toHaveText("Page");

  await page.keyboard.press("Enter"); // into the page: its first child
  await expect(heading(page)).toHaveText("Card 1");
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Button 1");
  await page.keyboard.press("ArrowRight");
  await expect(heading(page)).toHaveText("Text 1");
  await page.keyboard.press("ArrowRight"); // the last sibling stays
  await expect(heading(page)).toHaveText("Text 1");
  await page.keyboard.press("ArrowLeft");
  await expect(heading(page)).toHaveText("Button 1");
  await page.keyboard.press("Shift+Enter");
  await expect(heading(page)).toHaveText("Card 1");
  await expect(page.locator("[data-outline=selected]")).toHaveText("Card 1");
  await expect(layer(page, "Card 1")).toHaveAttribute("aria-selected", "true");
  // Said, not only shown.
  await expect(page.locator("[aria-live=polite]", { hasText: "Card 1 selected" })).toHaveCount(1);
  // The focused canvas wears the accent ring.
  await expect(canvas).toBeFocused();
  expect(await canvas.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");

  // The Layers list is the other keyboard path to a node, and the selection is one.
  await layer(page, "Text 1").focus();
  await page.keyboard.press("Space");
  await expect(heading(page)).toHaveText("Text 1");
  await expect(page.locator("[data-outline=selected]")).toHaveText("Text 1");

  await axeClean(page, "light");
  await button(page, "Dark theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // The frame keeps the design system's own (light) look; the sheet around it is dark.
  expect(await page.locator(".page-frame").evaluate((el) => getComputedStyle(el).colorScheme)).toBe("light");
  await axeClean(page, "dark");
});
