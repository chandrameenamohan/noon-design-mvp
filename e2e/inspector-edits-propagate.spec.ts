import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// e2e:inspector-edits-propagate (E10.4): the inspector is the manifest rendered in sections; each control kind
// edits through ONE set_prop; an edit in one browser shows on the other's canvas AND in its inspector; a typed
// value is one op, not one per keystroke; Reset sends null; gap and padding shade their space on the canvas
// while hovered or focused; a refusal is repeated beside its control; axe-clean light and dark.
const user = `e2e-${String(Date.now())}-inspector@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A component in the library (E10.5): a click adds it into the selection, as the "Add X" buttons did. */
const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Selected element" });
const radio = (page: Page, group: string, option: string) => inspector(page).getByRole("radiogroup", { name: group, exact: true }).getByRole("radio", { name: option, exact: true });
const field = (page: Page, name: string) => inspector(page).getByLabel(name, { exact: true });
const shades = (page: Page) => page.locator("[data-outline=shade]");
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};

/** Counts the set_prop ops THIS browser sends: the proof that typing is one op on commit, not one per keystroke. */
async function countingSetProps(page: Page): Promise<{ sent: () => number }> {
  let sent = 0;
  await page.routeWebSocket(/\/documents\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const parsed: unknown = JSON.parse(String(message));
      if (typeof parsed === "object" && parsed !== null && "op" in parsed && typeof parsed.op === "object" && parsed.op !== null && "type" in parsed.op && parsed.op.type === "set_prop") sent++;
      server.send(message);
    });
    server.onMessage((message) => { ws.send(message); });
  });
  return { sent: () => sent };
}

test("sections from the manifest; every control kind edits as one set_prop that the other browser's canvas and inspector follow; steppers, Reset, shading, an inline refusal; axe-clean light and dark", async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const ops = await countingSetProps(page);
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");

  // Page [Stack 1 [Button 1, Text 1], Card 1]
  await tile(page, "Stack").click();
  await layer(page, "Stack 1").click();
  await tile(page, "Button").click();
  await tile(page, "Text").click();
  await layer(page, "Page").click();
  await tile(page, "Card").click();
  await expect(other.locator("[data-node-id]")).toHaveCount(5);

  // The page itself has no props to edit; a node's inspector has the three sections, from the manifest.
  await expect(inspector(page).getByRole("heading", { level: 3 })).toHaveCount(0);
  await layer(page, "Stack 1").click();
  await expect(inspector(page).getByRole("heading", { level: 3 })).toHaveText(["Component", "Layout", "Props"]);
  await expect(inspector(page).getByText("Stack", { exact: true })).toBeVisible();
  // Stack declares align, direction and gap as layout: arrow segments and a stepper, and nothing else in Props.
  const layout = inspector(page).getByRole("region", { name: "Layout" });
  await expect(layout.getByRole("radiogroup")).toHaveCount(2);
  await expect(layout.getByRole("spinbutton", { name: "gap" })).toHaveCount(1);
  await expect(inspector(page).getByRole("region", { name: "Props" })).toContainText("No other properties");
  // Unset: the manifest default shows as the placeholder or resting state; nothing is checked; Reset is not offered.
  await expect(field(page, "gap")).toHaveValue("");
  await expect(field(page, "gap")).toHaveAttribute("placeholder", "8");
  await expect(radio(page, "direction", "column")).not.toBeChecked();
  await expect(layout.locator("[data-prop=direction] [data-default]")).toContainText("column");
  await expect(inspector(page).getByRole("button", { name: "Reset gap" })).toHaveCount(0);

  // Segmented enum: one click, one op; the other browser's canvas lays the stack out as a row, and its inspector shows the choice.
  await radio(page, "direction", "row").check();
  await expect(other.locator("[data-component=Stack] > .ds-stack")).toHaveCSS("flex-direction", "row");
  await expect(other.locator("[data-component=Stack] > .node-props")).toHaveText("direction=row");
  await layer(other, "Stack 1").click();
  await expect(radio(other, "direction", "row")).toBeChecked();
  expect(ops.sent()).toBe(1);

  // The stepper by keyboard: Up steps from the default (8 -> 9), Shift+Up by ten, each ONE op sent at once...
  await field(page, "gap").focus();
  await page.keyboard.press("ArrowUp");
  await expect(other.locator("[data-component=Stack] > .node-props")).toHaveText("direction=row gap=9");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(other.locator("[data-component=Stack] > .node-props")).toHaveText("direction=row gap=19");
  expect(ops.sent()).toBe(3);
  // ...and by the buttons.
  await button(page, "Increase gap").click();
  await expect(other.locator("[data-component=Stack] > .node-props")).toHaveText("direction=row gap=20");
  await expect(other.locator("[data-component=Stack] > .ds-stack")).toHaveCSS("gap", "20px");
  await expect(field(other, "gap")).toHaveValue("20");
  await button(page, "Decrease gap").click();
  await expect(field(other, "gap")).toHaveValue("19");
  expect(ops.sent()).toBe(5);

  // Typing: the keystrokes are not ops; Enter is. Then Reset sends null: the prop is gone, the placeholder is back.
  await field(page, "gap").fill("12");
  await field(page, "gap").pressSequentially("3");
  expect(ops.sent()).toBe(5);
  await field(page, "gap").press("Enter");
  await expect(other.locator("[data-component=Stack] > .node-props")).toHaveText("direction=row gap=123");
  expect(ops.sent()).toBe(6);
  await button(page, "Reset gap").click();
  await expect(other.locator("[data-component=Stack] > .node-props")).toHaveText("direction=row");
  await expect(field(page, "gap")).toHaveValue("");
  await expect(inspector(page).getByRole("button", { name: "Reset gap" })).toHaveCount(0);
  await expect(other.locator("[data-component=Stack] > .ds-stack")).toHaveCSS("gap", "8px"); // the component's own default again

  // Shading: hovering the gap control shades the ONE space between the stack's two children; leaving clears it; focus shades it too.
  await field(page, "gap").hover();
  await expect(shades(page)).toHaveCount(1);
  const shade = await shades(page).boundingBox();
  const left = await page.locator("[data-component=Button] > .ds-button").boundingBox();
  const right = await page.locator("[data-component=Text] > :first-child").boundingBox();
  if (!shade || !left || !right) throw new Error("a box is missing");
  expect(shade.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  expect(shade.x + shade.width).toBeLessThanOrEqual(right.x + 1);
  await inspector(page).getByRole("heading", { level: 2 }).hover();
  await expect(shades(page)).toHaveCount(0);
  await field(page, "gap").focus();
  await expect(shades(page)).toHaveCount(1);
  await field(page, "gap").blur();
  await expect(shades(page)).toHaveCount(0);

  // Card declares padding: its ring is four strips, as wide as the padding the component applies (its default, 16).
  await layer(page, "Card 1").click();
  await expect(inspector(page).getByRole("region", { name: "Layout" }).getByRole("spinbutton", { name: "padding" })).toHaveCount(1);
  await field(page, "padding").hover();
  await expect(shades(page)).toHaveCount(4);
  const card = await page.locator("[data-component=Card] > .ds-card").boundingBox();
  const strip = await shades(page).first().boundingBox();
  if (!card || !strip) throw new Error("a box is missing");
  expect(strip.height).toBeCloseTo(16 * (Number(await page.locator(".world").getAttribute("data-zoom"))), 0);
  expect(strip.width).toBeCloseTo(card.width, 0);

  // The switch and the text field (Props): a switch sends at once; the other browser's Button is really disabled.
  await layer(page, "Button 1").click();
  await expect(inspector(page).getByRole("region", { name: "Layout" })).toContainText("declares no layout");
  const disabled = inspector(page).getByRole("switch", { name: "disabled" });
  await expect(disabled).not.toBeChecked();
  await disabled.check();
  await expect(other.locator("[data-component=Button] > .ds-button")).toBeDisabled();
  await layer(other, "Button 1").click();
  await expect(inspector(other).getByRole("switch", { name: "disabled" })).toBeChecked();
  await field(page, "label").fill("Go");
  await field(page, "label").blur();
  await expect(other.locator("[data-component=Button] > .ds-button")).toHaveText("Go");
  await expect(field(other, "label")).toHaveValue("Go");
  // A required prop has no unset state: no Reset for it.
  await expect(inspector(page).getByRole("button", { name: "Reset label" })).toHaveCount(0);
  await expect(inspector(page).getByRole("button", { name: "Reset disabled" })).toHaveCount(1);

  // A refused value: the notice says why, and so does the control's own row; the next accepted edit clears both.
  await field(page, "label").fill("x".repeat(10_001));
  await field(page, "label").press("Enter");
  await expect(page.getByRole("alert")).toHaveText(/too large/);
  await expect(inspector(page).locator("[data-prop=label][data-refused]")).toContainText("too large");
  await expect(field(page, "label")).toHaveAttribute("aria-describedby", /.+/);
  await axeClean(page, "light");
  await field(page, "label").fill("Fine");
  await field(page, "label").press("Enter");
  await expect(other.locator("[data-component=Button] > .ds-button")).toHaveText("Fine");
  await expect(inspector(page).locator("[data-refused]")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Dark: the same page, axe-clean.
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await layer(page, "Stack 1").click();
  await axeClean(page, "dark");
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
});
