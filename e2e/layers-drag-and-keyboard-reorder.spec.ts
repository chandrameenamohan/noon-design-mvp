import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// e2e:layers-drag-and-keyboard-reorder (E10.3): the layers are an ARIA tree whose selection is the canvas's,
// both ways; a drag shows a line (before/after) or a box (into) and sends ONE move_node; Alt+arrows and
// Delete do the same by keyboard; the other browser sees every move live; axe-clean light and dark.
const user = `e2e-${String(Date.now())}-layers@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A component in the library (E10.5): a click adds it into the selection, as the "Add X" buttons did. */
const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const heading = (page: Page) => page.getByRole("complementary", { name: "Selected element" }).getByRole("heading", { level: 2 });
/** The page's direct children on the canvas, in order. */
const pageChildren = (page: Page) => page.locator(".page-frame > [data-node-id]");
const componentsOf = async (rows: Locator): Promise<string[]> => rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-component") ?? ""));
const treeOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const walk = (el: Element): unknown => [...el.querySelectorAll("[data-node-id]")].filter((child) => child.parentElement?.closest("[data-node-id]") === el).map((child) => [child.getAttribute("data-component"), walk(child)]);
    const root = document.querySelector("[data-node-id=root]");
    return JSON.stringify(root ? walk(root) : "no root");
  });
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};
const middle = async (row: Locator): Promise<{ x: number; y: number; height: number }> => {
  const box = await row.boundingBox();
  if (!box) throw new Error("the row has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height };
};
/** Holds `from` and carries it over `to` at `at` of the row's height (0 the top edge, 0.5 the middle), without letting go. */
async function dragOver(page: Page, from: Locator, to: Locator, at: number): Promise<void> {
  const start = await middle(from);
  const end = await middle(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 2, start.y + 6, { steps: 2 }); // past the 4 px that tell a drag from a click
  await page.mouse.move(end.x, end.y - end.height / 2 + end.height * at, { steps: 6 });
}

/** Counts the move_node ops THIS browser sends: the proof that a drag is one op, not a remove and an add, nor one per pixel. */
async function countingMoves(page: Page): Promise<{ moves: () => number }> {
  let moves = 0;
  await page.routeWebSocket(/\/documents\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const parsed: unknown = JSON.parse(String(message));
      if (typeof parsed === "object" && parsed !== null && "op" in parsed && typeof parsed.op === "object" && parsed.op !== null && "type" in parsed.op && parsed.op.type === "move_node") moves++;
      server.send(message);
    });
    server.onMessage((message) => { ws.send(message); });
  });
  return { moves: () => moves };
}

test("the tree mirrors the canvas both ways; drag reorders and nests as ONE move_node with a line or a box; Alt+arrows and Delete by keyboard; the other browser sees every move; axe-clean light and dark", async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const sent = await countingMoves(page);
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");

  // Page [Card 1 [Button 1], Stack 1, Text 1]
  await tile(page, "Card").click();
  await layer(page, "Card 1").click();
  await tile(page, "Button").click();
  await layer(page, "Page").click();
  await tile(page, "Stack").click();
  await layer(page, "Page").click(); // the new stack is selected (E10.5); the text is to land beside it
  await tile(page, "Text").click();
  await expect(other.locator("[data-node-id]")).toHaveCount(5);

  // An ARIA tree: levels, expanded state on rows with children only, one tab stop.
  const tree = page.getByRole("tree", { name: "Layers" });
  await expect(tree.getByRole("treeitem")).toHaveCount(5);
  await expect(layer(page, "Page")).toHaveAttribute("aria-level", "1");
  await expect(layer(page, "Card 1")).toHaveAttribute("aria-level", "2");
  await expect(layer(page, "Card 1")).toHaveAttribute("aria-expanded", "true");
  await expect(layer(page, "Button 1")).toHaveAttribute("aria-level", "3");
  await expect(layer(page, "Stack 1")).not.toHaveAttribute("aria-expanded", /.+/);
  await expect(tree.locator("[tabindex='0']")).toHaveCount(1);

  // Selection, both ways: the tree selects on the canvas, the canvas selects in the tree.
  await layer(page, "Text 1").click();
  await expect(heading(page)).toHaveText("Text 1");
  await expect(page.locator("[data-outline=selected]")).toHaveText("Text 1");
  await expect(layer(page, "Text 1")).toHaveAttribute("aria-selected", "true");
  await expect(layer(page, "Text 1")).toHaveAttribute("tabindex", "0");
  const realButton = await page.locator("[data-node-id][data-component=Button] > button.ds-button").boundingBox();
  if (!realButton) throw new Error("no button on the canvas");
  await page.mouse.click(realButton.x + realButton.width / 2, realButton.y + realButton.height / 2);
  await expect(layer(page, "Button 1")).toHaveAttribute("aria-selected", "true");
  await expect(layer(page, "Text 1")).toHaveAttribute("aria-selected", "false");

  // Drag Text 1 INTO Stack 1: the container wears a box while the pointer is over its middle; the drop is one op.
  await dragOver(page, layer(page, "Text 1"), layer(page, "Stack 1"), 0.5);
  await expect(layer(page, "Stack 1")).toHaveAttribute("data-drop", "into");
  await expect(layer(page, "Text 1")).toHaveAttribute("data-dragging", "");
  expect(await layer(page, "Stack 1").evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  await page.mouse.up();
  await expect(other.locator("[data-component=Stack] [data-component=Text]")).toHaveCount(1);
  await expect(layer(other, "Text 1")).toHaveAttribute("aria-level", "3");
  await expect(layer(page, "Stack 1")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[aria-live=polite]", { hasText: "Text 1 moved into Stack 1" })).toHaveCount(1);
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  expect(sent.moves()).toBe(1);

  // Drag Button 1 to BEFORE Stack 1: a line at the row's top edge; the button lands between the card and the stack.
  await dragOver(page, layer(page, "Button 1"), layer(page, "Stack 1"), 0.1);
  await expect(layer(page, "Stack 1")).toHaveAttribute("data-drop", "before");
  expect(await layer(page, "Stack 1").evaluate((el) => getComputedStyle(el, "::after").height)).toBe("2px");
  await page.mouse.up();
  await expect.poll(() => componentsOf(pageChildren(other))).toEqual(["Card", "Button", "Stack"]);
  await expect(layer(page, "Button 1")).toHaveAttribute("aria-level", "2");
  expect(sent.moves()).toBe(2);

  // A row that takes no children never offers "into": over the button's middle the line shows where the node WOULD go.
  await dragOver(page, layer(page, "Stack 1"), layer(page, "Button 1"), 0.5);
  await expect(layer(page, "Button 1")).toHaveAttribute("data-drop", /^(before|after)$/);
  // ...and its own child refuses it outright; letting go there sends nothing.
  const child = await middle(layer(page, "Text 1"));
  await page.mouse.move(child.x, child.y, { steps: 3 });
  await expect(layer(page, "Text 1")).toHaveAttribute("data-drop", "none");
  await page.mouse.up();
  await expect(tree.locator("[data-drop]")).toHaveCount(0);
  expect(await componentsOf(pageChildren(page))).toEqual(["Card", "Button", "Stack"]);
  expect(sent.moves()).toBe(2);

  // Keyboard: Alt+Left outdents (after its parent), Alt+Up and Alt+Down reorder, Alt+Right nests into the row above.
  await layer(page, "Text 1").click();
  await expect(layer(page, "Text 1")).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(() => componentsOf(pageChildren(other))).toEqual(["Card", "Button", "Stack", "Text"]);
  await expect(layer(page, "Text 1")).toBeFocused(); // the row moved; the focus went with it
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => componentsOf(pageChildren(other))).toEqual(["Card", "Button", "Text", "Stack"]);
  // The row above is the button, which takes no children: the tree does not guess; the refusal is the replica's, in words.
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("alert")).toHaveText(/cannot hold other elements/);
  expect(await componentsOf(pageChildren(page))).toEqual(["Card", "Button", "Text", "Stack"]);
  await button(page, "Dismiss").click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => componentsOf(pageChildren(other))).toEqual(["Card", "Button", "Stack", "Text"]);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(other.locator("[data-component=Stack] [data-component=Text]")).toHaveCount(1);
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  expect(sent.moves()).toBe(6);

  // Arrows walk the shown rows and select as they go; Left folds a row (its children leave the tree), Right opens it, then goes in.
  await page.keyboard.press("Home");
  await expect(heading(page)).toHaveText("Page");
  await page.keyboard.press("ArrowDown");
  await expect(heading(page)).toHaveText("Card 1");
  await expect(layer(page, "Card 1")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(heading(page)).toHaveText("Button 1");
  await page.keyboard.press("ArrowLeft"); // a leaf: to its parent
  await expect(heading(page)).toHaveText("Card 1");
  await layer(page, "Page").click();
  await page.keyboard.press("ArrowDown"); // Card 1
  await page.keyboard.press("ArrowDown"); // Button 1
  await page.keyboard.press("ArrowDown"); // Stack 1, which holds Text 1
  await expect(heading(page)).toHaveText("Stack 1");
  await page.keyboard.press("ArrowLeft");
  await expect(layer(page, "Stack 1")).toHaveAttribute("aria-expanded", "false");
  await expect(layer(page, "Text 1")).toHaveCount(0);
  await expect(other.locator("[data-component=Stack] [data-component=Text]")).toHaveCount(1); // folding is this browser's view, not an edit
  await page.keyboard.press("ArrowRight");
  await expect(layer(page, "Stack 1")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(heading(page)).toHaveText("Text 1");
  await expect(layer(page, "Text 1")).toBeFocused();
  await page.keyboard.press("End");
  await expect(heading(page)).toHaveText("Text 1"); // the last shown row

  // Delete removes the selected layer, in both browsers; the selection and the focus fall back to the page.
  await layer(page, "Button 1").click();
  await page.keyboard.press("Delete");
  await expect(other.locator("[data-component=Button]")).toHaveCount(0);
  await expect(layer(page, "Button 1")).toHaveCount(0);
  await expect(heading(page)).toHaveText("Page");
  await expect(layer(page, "Page")).toBeFocused();

  // A move by the OTHER person appears here live.
  await layer(other, "Text 1").click();
  await other.keyboard.press("Alt+ArrowLeft");
  await expect(layer(page, "Text 1")).toHaveAttribute("aria-level", "2");
  await expect.poll(() => componentsOf(pageChildren(page))).toEqual(["Card", "Stack", "Text"]);
  await expect(other.getByText("saved", { exact: true })).toBeVisible();
  expect(await treeOf(page)).toBe(await treeOf(other));

  await axeClean(page, "light");
  await button(page, "Dark theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await axeClean(page, "dark");
});
