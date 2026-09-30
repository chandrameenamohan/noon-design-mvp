import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// F5 + F6: every kind of edit from the UI, what a refusal looks like, and what a lost race looks like.
const user = `e2e-${String(Date.now())}-edit@example.com`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A component in the library (E10.5): a click adds it into the selection, as the "Add X" buttons did. */
const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const treeOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    // A node's children are the wrappers whose nearest wrapper ancestor it is: the real component sits in between (E10.2).
    const walk = (el: Element): unknown => [...el.querySelectorAll("[data-node-id]")].filter((child) => child.parentElement?.closest("[data-node-id]") === el).map((child) => [child.getAttribute("data-node-id"), child.querySelector(":scope > .node-props")?.textContent, walk(child)]);
    const root = document.querySelector("[data-node-id=root]");
    return JSON.stringify(root ? walk(root) : "no root");
  });

async function newDocument(page: Page): Promise<string> {
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
  return page.url();
}
/**
 * A second browser whose OUTGOING frames the test can hold back: the deterministic way to make
 * "two people did this at the same moment" happen. While held, its edits are optimistic only.
 */
async function openHeld(browser: Browser, url: string) {
  const page = await (await browser.newContext()).newPage();
  let held: (() => void)[] | undefined;
  await page.routeWebSocket(/\/documents\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => { if (held) held.push(() => { server.send(message); }); else server.send(message); });
    server.onMessage((message) => { ws.send(message); });
  });
  await page.goto(url);
  await expect(page.getByRole("status")).toHaveText("live");
  return { page, hold: () => { held = []; }, release: () => { const waiting = held ?? []; held = undefined; for (const send of waiting) send(); } };
}

test("props, move, reorder and remove from the UI all reach the other browser, and the trees end identical", async ({ page, browser }) => {
  const url = await newDocument(page);
  const other = await (await browser.newContext()).newPage();
  await other.goto(url);

  await tile(page, "Card").click();
  await layer(page, "Page").click(); // a new node is selected (E10.5); the next two are to land on the page, not in the card
  await tile(page, "Text").click();
  await tile(page, "Button").click(); // after the selected text

  // A prop, typed: the form comes from the manifest (Text.value is a string, Text.size an enum of three: a segmented choice, E10.4).
  await layer(page, "Text 1").click();
  await page.getByLabel("value", { exact: true }).fill("Hello");
  await page.getByLabel("value", { exact: true }).blur();
  await page.getByRole("radiogroup", { name: "size", exact: true }).getByRole("radio", { name: "lg", exact: true }).check();
  await expect(other.locator("[data-component=Text] > .node-props")).toHaveText("value=Hello size=lg");

  // Move INTO a container.
  await page.getByLabel("Move into", { exact: true }).selectOption({ label: "Card 1" });
  await button(page, "Move").click();
  await expect(other.locator("[data-component=Card] [data-component=Text]")).toHaveCount(1);

  // Reorder among siblings: the page holds [Card, Button]; Button moves up.
  await layer(page, "Button 1").click();
  await button(page, "Move up").click();
  await expect(other.locator("[data-node-id=root] [data-node-id]").first()).toHaveAttribute("data-component", "Button");
  await button(page, "Move down").click();
  await expect(other.locator("[data-node-id=root] [data-node-id]").first()).toHaveAttribute("data-component", "Card");

  // Clearing an optional prop removes it (set_prop with null): Reset, offered while the prop is set.
  await layer(page, "Text 1").click();
  await button(page, "Reset size").click();
  await expect(other.locator("[data-component=Text] > .node-props")).toHaveText("value=Hello");

  // Remove, from the OTHER browser: the subtree goes with it.
  await layer(other, "Card 1").click();
  await button(other, "Remove").click();
  await expect(page.locator("[data-component=Card], [data-component=Text]")).toHaveCount(0);
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  expect(await treeOf(page)).toBe(await treeOf(other));
});

test("an edit the document's rules forbid never leaves the page, and says why", async ({ page }) => {
  await newDocument(page);
  await tile(page, "Card").click();
  await layer(page, "Card 1").click();
  await tile(page, "Stack").click(); // inside the card
  await layer(page, "Card 1").click();
  await page.getByLabel("Move into", { exact: true }).selectOption({ label: "Stack 1" }); // into its own child
  await button(page, "Move").click();
  await expect(page.getByRole("alert")).toHaveText(/cannot be moved inside itself/);
  await expect(page.locator("[data-node-id=root] > [data-component=Card]")).toHaveCount(1);
});

test("an edit the SERVER refuses is rolled back and its reason is shown; the other browser never sees it", async ({ page, browser }) => {
  const url = await newDocument(page);
  await tile(page, "Card").click();
  await layer(page, "Page").click();
  await tile(page, "Stack").click();
  const late = await openHeld(browser, url);

  // Both are valid alone; together they are a cycle. The server takes whichever arrives first.
  late.hold();
  await layer(late.page, "Card 1").click();
  await late.page.getByLabel("Move into", { exact: true }).selectOption({ label: "Stack 1" });
  await button(late.page, "Move").click();
  await expect(late.page.locator("[data-component=Stack] [data-component=Card]")).toHaveCount(1); // optimistic

  await layer(page, "Stack 1").click();
  await page.getByLabel("Move into", { exact: true }).selectOption({ label: "Card 1" });
  await button(page, "Move").click();
  await expect(page.getByText("saved", { exact: true })).toBeVisible();

  late.release();
  await expect(late.page.getByRole("alert")).toHaveText(/cannot be moved inside itself/);
  await expect(late.page.locator("[data-component=Card] [data-component=Stack]")).toHaveCount(1); // rolled back to the server's order
  expect(await treeOf(late.page)).toBe(await treeOf(page));
  await expect(page.getByRole("alert")).toHaveCount(0);

  await button(late.page, "Dismiss").click();
  await expect(late.page.getByRole("alert")).toHaveCount(0);
});

test("an edit to a node someone else just removed simply disappears: no error, no leftovers", async ({ page, browser }) => {
  const url = await newDocument(page);
  await tile(page, "Text").click();
  const late = await openHeld(browser, url);

  late.hold();
  await layer(late.page, "Text 1").click();
  await late.page.getByLabel("value", { exact: true }).fill("too late");
  await late.page.getByLabel("value", { exact: true }).blur();
  await expect(late.page.locator("[data-component=Text] > .node-props")).toHaveText("value=too late");

  await layer(page, "Text 1").click();
  await button(page, "Remove").click();
  await expect(late.page.locator("[data-component=Text]")).toHaveCount(0); // the remove arrives; the node goes

  late.release(); // the server answers "gone"
  await expect(late.page.getByText("saved", { exact: true })).toBeVisible();
  await expect(late.page.getByRole("alert")).toHaveCount(0);
  await expect(late.page.getByRole("heading", { name: "Page", exact: true })).toBeVisible(); // the selection fell back to the page
  expect(await treeOf(late.page)).toBe(await treeOf(page));
});

test("a number the browser cannot read (1e999) changes nothing; it must not be taken for 'clear this prop'", async ({ page }) => {
  await newDocument(page);
  await tile(page, "Card").click();
  await layer(page, "Card 1").click();
  const padding = page.getByLabel("padding", { exact: true });
  await padding.fill("8");
  await padding.press("Enter");
  await expect(page.locator("[data-component=Card] > .node-props")).toHaveText("padding=8");

  // <input type=number> reports "" for text it cannot parse, exactly what an emptied field reports.
  await padding.press("ControlOrMeta+a");
  await padding.pressSequentially("1e999");
  await padding.blur();
  await expect(page.locator("[data-component=Card] > .node-props")).toHaveText("padding=8");
  await expect(padding).toHaveValue("8");

  // Negative zero is zero to a person; the contract refuses it (JSON cannot carry it), so the form sends 0.
  await padding.fill("-0");
  await padding.press("Enter");
  await expect(page.locator("[data-component=Card] > .node-props")).toHaveText("padding=0");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
