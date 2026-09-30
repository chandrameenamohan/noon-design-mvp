import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { describeKeys, SCOPES, SHORTCUTS, shortcutsIn } from "../apps/web/src/shortcuts.ts";
import { expect, test } from "./fixtures.ts";

// e2e:shortcut-sheet (E10.7): `?` opens a modal sheet that lists every shortcut of the ONE registry, traps focus,
// closes on Escape and gives focus back; `?` typed in a field stays a `?`; and the registry's keys are the keys
// that work (a sample from each scope, pressed).
const user = `e2e-${String(Date.now())}-sheet@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const heading = (page: Page) => page.getByRole("complementary", { name: "Selected element" }).getByRole("heading", { level: 2 });
const focusInSheet = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest("dialog") !== null && document.activeElement !== document.body);
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};

async function newDocument(page: Page): Promise<void> {
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
}

test("? opens the sheet with every registered shortcut by scope; focus stays inside; Escape closes it and focus comes back", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await newDocument(page);
  await expect(sheet(page)).toBeHidden();

  // From the canvas (focused by a click on the empty sheet), ? is the global shortcut.
  const canvas = page.getByRole("region", { name: "Canvas" });
  await canvas.focus();
  await page.keyboard.press("?");
  await expect(sheet(page)).toBeVisible();
  expect(await focusInSheet(page)).toBe(true);

  // The registry, rendered: every scope's title, and every shortcut's keys and sentence.
  for (const scope of SCOPES) {
    const section = sheet(page).getByRole("region", { name: scope.title });
    await expect(section).toBeVisible();
    for (const s of shortcutsIn(scope.id)) {
      await expect(section.getByRole("term").filter({ hasText: describeKeys(s) })).toHaveCount(1);
      await expect(section.getByRole("definition").filter({ hasText: s.does })).toHaveCount(1);
    }
  }
  await expect(sheet(page).getByRole("term")).toHaveCount(SHORTCUTS.length);
  await axeClean(page, "light");

  // A modal: Tab from the last control wraps to the first, never leaving the dialog; the page behind takes no key.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await focusInSheet(page), `Tab ${String(i + 1)} stays in the sheet`).toBe(true);
  }
  await page.keyboard.press("p"); // the global preview toggle: nothing, the sheet is up
  await expect(page.getByRole("region", { name: "Preview" })).toHaveCount(0);

  // Escape closes it, and the canvas has focus again.
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(canvas).toBeFocused();
  // Escape reached the sheet, not the canvas: the selection did not change (it was the page already), and the canvas is whole.
  await expect(heading(page)).toHaveText("Page");

  // The bar's ? button opens it too, and Close closes it.
  await button(page, "Keyboard shortcuts (?)").click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toBeHidden();

  // In a field, ? is a character.
  const search = page.getByLabel("Search components");
  await search.click();
  await page.keyboard.press("?");
  await expect(search).toHaveValue("?");
  await expect(sheet(page)).toBeHidden();
  await search.fill("");

  // Dark too.
  await button(page, "Dark theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await canvas.focus();
  await page.keyboard.press("?");
  await expect(sheet(page)).toBeVisible();
  await axeClean(page, "dark");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
});

test("the keys the sheet lists are the keys that work: one from each scope, pressed", async ({ page }) => {
  await newDocument(page);
  await tile(page, "Card").click();
  await layer(page, "Card 1").click();
  await tile(page, "Button").click(); // into the card
  await tile(page, "Text").click(); // into the card, after the button

  // Canvas: Escape selects the page, Enter goes in, arrows step, 0 fits.
  const canvas = page.getByRole("region", { name: "Canvas" });
  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect(heading(page)).toHaveText("Page");
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Card 1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await expect(heading(page)).toHaveText("Text 1");
  await page.keyboard.press("Shift+Enter");
  await expect(heading(page)).toHaveText("Card 1");
  const fitted = Number(await page.locator(".world").getAttribute("data-zoom"));
  await page.keyboard.press("+");
  await expect.poll(async () => Number(await page.locator(".world").getAttribute("data-zoom"))).toBeGreaterThan(fitted);
  await page.keyboard.press("0");
  await expect.poll(async () => Number(await page.locator(".world").getAttribute("data-zoom"))).toBe(fitted);

  // Layers: Alt+Up moves the Text before the Button, as ONE move; Home selects the page.
  await layer(page, "Text 1").focus();
  await page.keyboard.press("Space");
  await expect(heading(page)).toHaveText("Text 1");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator("[data-node-id][data-component=Card] [data-node-id]").first()).toHaveAttribute("data-component", "Text");
  await page.keyboard.press("Home");
  await expect(heading(page)).toHaveText("Page");

  // Library: from the search box, Down reaches the components; End the last; Enter adds it into the page.
  const search = page.getByLabel("Search components");
  await search.click();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Components" }).getByRole("option").first()).toBeFocused();
  await page.keyboard.press("End");
  const last = page.getByRole("listbox", { name: "Components" }).getByRole("option").last();
  await expect(last).toBeFocused();
  const count = await page.locator("[data-node-id]").count();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-node-id]")).toHaveCount(count + 1);

  // Inspector: Enter applies a typed value.
  await layer(page, "Button 1").click();
  const label = page.getByLabel("label", { exact: true });
  await label.fill("Pressed");
  await label.press("Enter");
  await expect(page.locator("[data-node-id][data-component=Button] > button")).toHaveText("Pressed");

  // Everywhere: P opens the preview split; the divider's Left widens it.
  await canvas.focus();
  await page.keyboard.press("p");
  const divider = page.getByRole("separator", { name: "Preview width" });
  await expect(divider).toBeVisible();
  const width = Number(await divider.getAttribute("aria-valuenow"));
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", String(width + 24));
});
