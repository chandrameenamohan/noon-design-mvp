import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// e2e:preview-split-device-frames (E10.7): the running page opens as a split beside the canvas (the bar's toggle,
// and P), in a phone, tablet or desktop frame that fits the pane on its own, and the divider moves by pointer
// and by keyboard. The sandbox worker under test is the REAL one, as in preview.spec.ts. Every isolation rule
// of the frame is unchanged (an opaque origin, the URL asked for and never kept).
const user = `e2e-${String(Date.now())}-split@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const frame = (page: Page) => page.locator(".device-frame");
const iframe = (page: Page) => page.locator("iframe[title='Preview of this page']");
const divider = (page: Page) => page.getByRole("separator", { name: "Preview width" });
const box = async (page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
};
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};
/** The frame's unscaled CSS width (the device's) and the scale it is shown at. */
const frameGeometry = async (page: Page): Promise<{ width: number; scale: number }> =>
  frame(page).evaluate((el) => ({ width: parseFloat(getComputedStyle(el).width), scale: Number(el.getAttribute("data-scale")) }));

// A cold sandbox (first clone, first Vite transform) can take a while on a busy machine.
test.setTimeout(120_000);

test("the preview opens as a split beside the canvas, by the bar's toggle and by P; the divider resizes it by pointer and keyboard", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  await expect(region(page, "Preview")).toHaveCount(0);

  // The toggle in the bar.
  const toggle = button(page, "Preview");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const [canvas, preview] = await Promise.all([region(page, "Canvas").boundingBox(), region(page, "Preview").boundingBox()]);
  if (!canvas || !preview) throw new Error("a pane is missing");
  // Beside, not below: the canvas ends where the divider starts, the preview begins after it, both the same height.
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(preview.x);
  expect(Math.abs(canvas.y - preview.y)).toBeLessThan(2);
  expect(preview.width).toBeGreaterThanOrEqual(280);

  // The divider: focus it and move it with the keys; its value is the preview's width.
  const before = Number(await divider(page).getAttribute("aria-valuenow"));
  expect(before).toBe(Math.round(preview.width));
  await divider(page).focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(divider(page)).toHaveAttribute("aria-valuenow", String(before + 48));
  await expect.poll(async () => Math.round((await box(page, "section[aria-label='Preview']")).width)).toBe(before + 48);
  await page.keyboard.press("ArrowRight");
  await expect(divider(page)).toHaveAttribute("aria-valuenow", String(before + 24));
  // ...and by pointer: a drag to the right narrows the preview by the distance dragged.
  const grip = await box(page, "[role=separator]");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(divider(page)).toHaveAttribute("aria-valuenow", String(before + 24 - 60));
  // Never past the minimums.
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "280");
  await axeClean(page, "light");

  // P closes it (focus is on the divider, not in a field) and opens it again; the bar's toggle follows.
  await page.keyboard.press("p");
  await expect(region(page, "Preview")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("p");
  await expect(region(page, "Preview")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // In the search box, p is a letter.
  const search = page.getByLabel("Search components");
  await search.fill("");
  await search.press("p");
  await expect(search).toHaveValue("p");
  await expect(region(page, "Preview")).toBeVisible();

  await button(page, "Dark theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await axeClean(page, "dark");
});

test("phone 390, tablet 768 and desktop 1280: the frame is the device's width, scaled to fit the pane; the page inside sees that width, in the same opaque frame as before", async ({ page, baseURL }) => {
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  const documentId = new URL(page.url()).searchParams.get("doc") ?? "";
  await tile(page, "Button").click();
  await layer(page, "Button 1").click();
  await button(page, "Preview").click();

  const picker = page.getByRole("group", { name: "Device" });
  await expect(picker.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true");
  for (const [name, width] of [["Phone", 390], ["Tablet", 768], ["Desktop", 1280]] as const) {
    await picker.getByRole("button", { name }).click();
    await expect(picker.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    await expect(frame(page)).toHaveAttribute("data-device", name.toLowerCase());
    const geometry = await frameGeometry(page);
    expect(geometry.width).toBe(width);
    // The preview's own zoom-to-fit: the scaled frame fits the stage, life-size at most, and the readout says so.
    const stage = await box(page, ".device-stage");
    const shown = await box(page, ".device-frame");
    expect(geometry.scale).toBeLessThanOrEqual(1);
    expect(shown.width).toBeLessThanOrEqual(stage.width);
    expect(shown.height).toBeLessThanOrEqual(stage.height);
    expect(Math.abs(shown.width - width * geometry.scale)).toBeLessThan(2);
    await expect(page.locator(".preview .zoom-level")).toContainText(`${String(Math.round(geometry.scale * 100))}%`);
  }
  // Widening the preview refits the frame larger, still within the stage.
  const narrow = (await frameGeometry(page)).scale;
  await divider(page).focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await frameGeometry(page)).scale).toBeGreaterThan(narrow);

  // The running page arrives in the frame, under the unchanged rules: an opaque origin (no allow-same-origin),
  // this canvas's own origin behind the tunnel (noon-l96), the container's token in the path (noon-9gz).
  await expect(iframe(page)).toHaveAttribute("sandbox", "allow-scripts", { timeout: 90_000 });
  await expect(iframe(page)).toHaveAttribute("src", new RegExp(`^${baseURL ?? ""}/preview/${documentId}/[0-9a-f]{16}\\.[0-9a-f]{32}/noon-preview/`, "u"));
  const inner = page.frameLocator("iframe[title='Preview of this page']");
  await expect(inner.getByRole("button", { name: "Button" })).toBeVisible({ timeout: 90_000 });
  // The page measures itself at the DEVICE's width: the frame is 1280 CSS px wide however small it is drawn.
  expect(await inner.locator("body").evaluate(() => innerWidth)).toBe(1280);
  await picker.getByRole("button", { name: "Phone" }).click();
  await expect.poll(() => inner.locator("body").evaluate(() => innerWidth)).toBe(390);
  // The iframe fills the frame: the same box (the bezel is a shadow, outside it).
  const [frameBox, iframeBox] = await Promise.all([box(page, ".device-frame"), box(page, "iframe[title='Preview of this page']")]);
  expect(Math.abs(frameBox.width - iframeBox.width)).toBeLessThan(2);
  expect(Math.abs(frameBox.height - iframeBox.height)).toBeLessThan(2);
});
