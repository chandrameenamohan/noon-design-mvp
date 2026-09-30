import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// e2e:shell-light-dark (E10.1). The fixture runs axe once, at the end, in whatever theme the test left; the shell
// must be clean in BOTH, so each theme is checked here as it is shown.
const user = `e2e-${String(Date.now())}-shell@example.com`;
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};
const html = (page: Page) => page.locator("html");

test("a document opens in the three-pane shell, follows the OS theme, and the toggle overrides it and is remembered", async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const documentUrl = page.url();

  // The bar, and the three panes in Figma's order: layers left of the canvas, the inspector right of it.
  const bar = page.getByRole("banner");
  await expect(bar).toBeVisible();
  await expect(bar.getByText("saved", { exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Ship", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "AI", exact: true })).toHaveAttribute("aria-pressed", "true");
  const [layers, canvas, inspector] = await Promise.all([
    page.getByRole("region", { name: "Layers" }).boundingBox(),
    page.getByRole("region", { name: "Canvas" }).boundingBox(),
    page.getByRole("complementary", { name: "Selected element" }).boundingBox(),
  ]);
  if (!layers || !canvas || !inspector) throw new Error("a pane is missing");
  expect(layers.x + layers.width).toBeLessThanOrEqual(canvas.x + 1);
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(inspector.x + 1);
  await expect(page.getByRole("region", { name: "Library" }).getByRole("option", { name: "Card", exact: true })).toBeVisible();

  // Light, as the OS says; screenshot and axe.
  const toggle = page.getByRole("button", { name: "Dark theme", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await axeClean(page, "light");
  await expect(page).toHaveScreenshot("shell-light.png");

  // The toggle, by keyboard: dark, remembered across a reload.
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await axeClean(page, "dark");
  await expect(page).toHaveScreenshot("shell-dark.png");
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("live");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  // ...and it now outranks the OS.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).toHaveAttribute("data-theme", "dark");

  // The AI panel closes and opens from the bar, its textarea with it.
  const ai = page.getByRole("button", { name: "AI", exact: true });
  await ai.click();
  await expect(page.getByLabel("Ask the AI to change this page")).toBeHidden();
  await ai.click();
  await expect(page.getByLabel("Ask the AI to change this page")).toBeVisible();

  // A browser that never chose follows its OS: dark here, and it flips live when the OS does.
  const fresh = await (await browser.newContext({ colorScheme: "dark" })).newPage();
  await fresh.goto(documentUrl);
  await expect(fresh.getByRole("status")).toHaveText("live");
  await expect(html(fresh)).toHaveAttribute("data-theme", "dark");
  await expect(fresh.getByRole("button", { name: "Dark theme", exact: true })).toHaveAttribute("aria-pressed", "true");
  await fresh.emulateMedia({ colorScheme: "light" });
  await expect(html(fresh)).toHaveAttribute("data-theme", "light");
  await fresh.close();
});

test("home and sign-in use the same tokens: dark on a dark OS, axe-clean, and the toggle is there too", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await axeClean(page, "dark");
  await expect(page).toHaveScreenshot("home-dark.png");
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await axeClean(page, "light");
});
