import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// e2e:library-drag-to-canvas (E10.5): the library lists every manifest component as a searchable tile with a live
// render; a drag onto a container on the canvas, or onto a place in the layers tree, adds it there as ONE add_node
// at the index the drop line shows; Enter adds into the selection (after it when it is a leaf); the new node is
// selected; the other browser sees every add; axe-clean light and dark.
const user = `e2e-${String(Date.now())}-library@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const heading = (page: Page) => page.getByRole("complementary", { name: "Selected element" }).getByRole("heading");
const library = (page: Page) => page.getByRole("region", { name: "Library" });
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
const middle = async (target: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await target.boundingBox();
  if (!box) throw new Error("the target has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
};
/** Holds a tile and carries it to `at` (screen px), without letting go. */
async function carryTo(page: Page, from: Locator, at: { x: number; y: number }): Promise<void> {
  const start = await middle(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 2, start.y + 6, { steps: 2 }); // past the 4 px that tell a drag from a click
  await page.mouse.move(at.x, at.y, { steps: 8 });
}

/** Counts the add_node ops THIS browser sends: the proof that a drop is one op, not one per pixel, and a click one op. */
async function countingAdds(page: Page): Promise<{ adds: () => number }> {
  let adds = 0;
  await page.routeWebSocket(/\/documents\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const parsed: unknown = JSON.parse(String(message));
      if (typeof parsed === "object" && parsed !== null && "op" in parsed && typeof parsed.op === "object" && parsed.op !== null && "type" in parsed.op && parsed.op.type === "add_node") adds++;
      server.send(message);
    });
    server.onMessage((message) => { ws.send(message); });
  });
  return { adds: () => adds };
}

test("every component is a searchable tile with a live render; Enter, a click and a drag onto the canvas or the tree each add ONE node where shown, and select it; the other browser sees them; axe-clean light and dark", async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const sent = await countingAdds(page);
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");

  // A listbox of every manifest component, each tile a REAL render (the sample app's own classes), hidden from the
  // accessibility tree so the tile's name is the component's; the old "Add X" toolbar is gone.
  const list = library(page).getByRole("listbox", { name: "Components" });
  await expect(list.getByRole("option")).toHaveText(["Button", "Card", "Image", "Input", "Stack", "Text"]);
  await expect(tile(page, "Button").locator(".thumb-frame > button.ds-button")).toHaveText("Button");
  await expect(tile(page, "Card").locator(".thumb-frame > section.ds-card .thumb-block")).toHaveCount(2);
  await expect(tile(page, "Button").locator(".thumb")).toHaveAttribute("aria-hidden", "true");
  await expect(tile(page, "Button").locator(".thumb")).toHaveAttribute("inert", "");
  await expect(page.locator("[data-component]:not([data-node-id])")).toHaveCount(0); // a tile is not a node
  await expect(page.getByRole("button", { name: /^Add /u })).toHaveCount(0);
  await expect(list.locator("[tabindex='0']")).toHaveCount(1);

  // Search narrows the list; Down from the box lands on the first shown tile; Enter adds it into the page and selects it.
  const search = library(page).getByRole("searchbox", { name: "Search components" });
  await search.fill("sta");
  await expect(list.getByRole("option")).toHaveText(["Stack"]);
  await search.press("ArrowDown");
  await expect(tile(page, "Stack")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(other.locator("[data-component=Stack]")).toHaveCount(1);
  await expect(heading(page)).toHaveText("Stack 1");
  await expect(layer(page, "Stack 1")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[aria-live=polite]", { hasText: "Stack added to Page, position 1" })).toHaveCount(1);
  await expect(tile(page, "Stack")).toBeFocused(); // the focus stays in the library: the next add is one key away
  expect(sent.adds()).toBe(1);
  await search.fill("zzz");
  await expect(list.getByRole("option")).toHaveCount(0);
  await expect(library(page).getByText("No component is called that.")).toBeVisible();
  await search.fill("");
  await expect(list.getByRole("option")).toHaveCount(6);

  // The empty stack has room on the canvas to be dropped into. Drag the Button tile onto it: a box round the stack with
  // its name, a line where the button lands; letting go is ONE add_node, into the stack, and the new button is selected.
  const stack = await middle(page.locator("[data-node-id][data-component=Stack] > .ds-stack"));
  expect(stack.height).toBeGreaterThanOrEqual(20);
  await carryTo(page, tile(page, "Button"), stack);
  await expect(tile(page, "Button")).toHaveAttribute("data-dragging", "");
  await expect(page.locator("[data-outline=insert]")).toHaveText("Stack 1");
  await expect(page.locator("[data-outline=insert-line]")).toHaveCount(1);
  await page.mouse.up();
  await expect(other.locator("[data-component=Stack] [data-component=Button]")).toHaveCount(1);
  await expect(heading(page)).toHaveText("Button 1");
  await expect(page.locator("[data-outline=insert]")).toHaveCount(0);
  expect(sent.adds()).toBe(2);

  // Enter with a LEAF selected adds after it, in its parent: the text follows the button inside the stack.
  await tile(page, "Text").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => componentsOf(other.locator("[data-node-id][data-component=Stack] > .ds-stack > [data-node-id]"))).toEqual(["Button", "Text"]);
  await expect(heading(page)).toHaveText("Text 1");
  expect(sent.adds()).toBe(3);

  // Onto the canvas BETWEEN two children: over the stack's text (a leaf), the component goes right after it.
  const text = await middle(page.locator("[data-node-id][data-component=Text] > .ds-text"));
  await carryTo(page, tile(page, "Input"), text);
  await expect(page.locator("[data-outline=insert]")).toHaveText("Stack 1");
  await page.mouse.up();
  await expect.poll(() => componentsOf(other.locator("[data-node-id][data-component=Stack] > .ds-stack > [data-node-id]"))).toEqual(["Button", "Text", "Input"]);
  expect(sent.adds()).toBe(4);

  // Onto the TREE: a line at the top edge of the stack's row, and the card lands before the stack on the page.
  const row = await middle(layer(page, "Stack 1"));
  await carryTo(page, tile(page, "Card"), { x: row.x, y: row.y - row.height / 2 + row.height * 0.1 });
  await expect(layer(page, "Stack 1")).toHaveAttribute("data-drop", "before");
  expect(await layer(page, "Stack 1").evaluate((el) => getComputedStyle(el, "::after").height)).toBe("2px");
  await page.mouse.up();
  await expect.poll(() => componentsOf(pageChildren(other))).toEqual(["Card", "Stack"]);
  await expect(heading(page)).toHaveText("Card 1");
  await expect(layer(page, "Stack 1")).not.toHaveAttribute("data-drop", /.+/);
  expect(sent.adds()).toBe(5);

  // Beside the page itself there is no place: the row says so, and letting go there sends nothing.
  const pageRow = await middle(layer(page, "Page"));
  await carryTo(page, tile(page, "Text"), { x: pageRow.x, y: pageRow.y - pageRow.height / 2 + pageRow.height * 0.1 });
  await expect(layer(page, "Page")).toHaveAttribute("data-drop", "none");
  await page.mouse.up();
  expect(await componentsOf(pageChildren(page))).toEqual(["Card", "Stack"]);
  expect(sent.adds()).toBe(5);
  // Nor over the library itself: Escape lets go of a carried tile without adding.
  await carryTo(page, tile(page, "Text"), await middle(tile(page, "Image")));
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(sent.adds()).toBe(5);

  // A click adds where Enter would: into the selected card.
  await layer(page, "Card 1").click();
  await tile(page, "Image").click();
  await expect(other.locator("[data-component=Card] [data-component=Image]")).toHaveCount(1);
  await expect(heading(page)).toHaveText("Image 1");
  expect(sent.adds()).toBe(6);

  // Arrows walk the tiles; Home and End jump.
  await tile(page, "Button").focus();
  await page.keyboard.press("ArrowDown");
  await expect(tile(page, "Card")).toBeFocused();
  await expect(tile(page, "Card")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tile(page, "Text")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tile(page, "Button")).toBeFocused();

  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  await expect(other.getByText("saved", { exact: true })).toBeVisible();
  expect(await treeOf(page)).toBe(await treeOf(other));

  await axeClean(page, "light");
  await button(page, "Dark theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await axeClean(page, "dark");
});
