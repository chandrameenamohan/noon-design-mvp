import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// F4: two browsers, one document. The whole path is real: page -> api (session) -> peer-client ->
// WebSocket -> the room -> the other page's DOM.
const user = `e2e-${String(Date.now())}@example.com`;

async function open(browser: Browser, url: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  await expect(page.getByRole("status")).toHaveText("live");
  return page;
}
/** The tree as the page shows it: nested [component, children]. Two pages that agree print the same thing. */
const treeOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const walk = (el: Element): unknown => [...el.querySelectorAll(":scope > [data-children] > [data-node-id]")].map((child) => [child.getAttribute("data-node-id"), child.getAttribute("data-component"), walk(child)]);
    const root = document.querySelector("[data-node-id=root]");
    return JSON.stringify(root ? walk(root) : "no root");
  });

test("a node added in one browser appears in the other; p95 under 200 ms over 25 edits; the trees end identical", async ({ page, browser }) => {
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const other = await open(browser, page.url());

  const latencies: number[] = [];
  for (let i = 1; i <= 25; i++) {
    // Alternate the editor, so both directions are measured. Timed in the test process: it includes
    // Playwright's own round trips, which only makes the number pessimistic.
    const [from, to] = i % 2 === 1 ? [page, other] : [other, page];
    const started = Date.now();
    await from.getByRole("button", { name: i % 3 === 0 ? "Add Text" : "Add Stack", exact: true }).click();
    await to.waitForFunction((count) => document.querySelectorAll("[data-node-id]:not([data-node-id=root])").length >= count, i, { polling: "raf" });
    latencies.push(Date.now() - started);
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1] ?? Infinity;
  test.info().annotations.push({ type: "latency", description: `local commit -> peer DOM: p50 ${String(latencies[12])} ms, p95 ${String(p95)} ms, max ${String(latencies.at(-1))} ms` });
  expect(p95).toBeLessThan(200);

  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  await expect(other.getByText("saved", { exact: true })).toBeVisible();
  expect(await treeOf(page)).toBe(await treeOf(other));
  expect((await treeOf(page)).match(/Stack|Text/g)).toHaveLength(25);

  // A third browser arriving late gets the same document from the room.
  const late = await open(browser, page.url());
  expect(await treeOf(late)).toBe(await treeOf(page));
});

test("a node can be added INSIDE a selected container, and the other browser nests it the same way", async ({ page, browser }) => {
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live"); // only now does the address bar name the document
  const other = await open(browser, page.url());
  await page.getByRole("button", { name: "Add Card", exact: true }).click();
  await page.getByRole("button", { name: "Select Card", exact: true }).click();
  await page.getByRole("button", { name: "Add Button", exact: true }).click();
  await expect(other.locator("[data-component=Card] [data-component=Button]")).toHaveCount(1);
  expect(await treeOf(page)).toBe(await treeOf(other));
});

test.describe("a document that cannot be opened", () => {
  // The browser itself logs every failed request; here a 404 is the point of the test.
  test.use({ allowedConsole: /40[04] \((Not Found|Bad Request)\)/ });

  for (const [what, id] of [["does not exist", "11111111-1111-4111-8111-111111111111"], ["is not an id at all", "abc"]] as const) {
    test(`a link to a document that ${what} says so, once, and stops trying`, async ({ page }) => {
      const sessions: string[] = [];
      page.on("request", (request) => { if (request.url().includes("/session")) sessions.push(request.url()); });
      await page.goto(`/?user=${user}&doc=${id}`);
      await expect(page.getByRole("alert")).toContainText("cannot be opened");
      await page.waitForTimeout(1500); // several retry periods, had it been retrying
      // (React's StrictMode mounts twice in development; the first mount is closed before it asks.)
      expect(sessions).toHaveLength(1);
    });
  }
});
