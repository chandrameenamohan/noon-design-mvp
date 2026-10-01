import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// F4: two browsers, one document. The whole path is real: page -> api (session) -> peer-client ->
// WebSocket -> the room -> the other page's DOM.
const user = `e2e-${String(Date.now())}@example.com`;

/** `before`: whatever must be listening before the page connects (its socket opens during goto). */
async function open(browser: Browser, url: string, before?: (page: Page) => void): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  before?.(page);
  await page.goto(url);
  await expect(page.getByRole("status")).toHaveText("live");
  return page;
}
/**
 * The tree as the page shows it: nested [component, children]. Two pages that agree print the same thing.
 * A node's children are the wrappers whose nearest wrapper ancestor it is: the real component sits in between (E10.2).
 * A canvas node carries data-component; a layers row (E10.3) carries data-node-id too and comes first in the page,
 * so every selector here names the canvas's nodes, not "the first element with that id".
 */
const treeOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const walk = (el: Element): unknown => [...el.querySelectorAll("[data-node-id][data-component]")].filter((child) => child.parentElement?.closest("[data-node-id]") === el).map((child) => [child.getAttribute("data-node-id"), child.getAttribute("data-component"), walk(child)]);
    const root = document.querySelector("[data-node-id=root][data-component]");
    return JSON.stringify(root ? walk(root) : "no root");
  });

/** An op frame on one of a page's sockets, stamped with the test's clock (which the pages share: one machine). */
type Frame = { at: number; dir: "sent" | "received"; opId: string };

/**
 * noon-ibo: one run measured p95 3072 ms and the next four passed. So that a slow run says WHERE the time
 * went, each page's op frames (Playwright sees the socket from outside) and console lines are kept.
 */
function watch(page: Page, name: string, frames: Map<Page, Frame[]>, consoleLines: string[]): void {
  const mine: Frame[] = [];
  frames.set(page, mine);
  const note = (dir: Frame["dir"]) => ({ payload }: { payload: string | Buffer }): void => {
    if (typeof payload !== "string") return;
    const message = JSON.parse(payload) as { type?: unknown; opId?: unknown };
    if (message.type === "op" && typeof message.opId === "string") mine.push({ at: Date.now(), dir, opId: message.opId });
  };
  page.on("websocket", (ws) => { ws.on("framesent", note("sent")); ws.on("framereceived", note("received")); });
  page.on("console", (msg) => { consoleLines.push(`${String(Date.now())} ${name} ${msg.type()}: ${msg.text()}`); });
}

test("a node added in one browser appears in the other; p95 under 200 ms over 25 edits; the trees end identical", async ({ page, browser }) => {
  const frames = new Map<Page, Frame[]>();
  const consoleLines: string[] = [];
  watch(page, "first", frames, consoleLines);
  await page.goto(`/?user=${user}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const other = await open(browser, page.url(), (opened) => { watch(opened, "second", frames, consoleLines); });

  const edits: { i: number; from: Page; to: Page; started: number; clicked: number; rendered: number; done: number }[] = [];
  for (let i = 1; i <= 25; i++) {
    // Alternate the editor, so both directions are measured. Timed in the test process: it includes
    // Playwright's own round trips, which only makes the number pessimistic.
    const [from, to] = i % 2 === 1 ? [page, other] : [other, page];
    const started = Date.now();
    await from.getByRole("option", { name: i % 3 === 0 ? "Text" : "Stack", exact: true }).click();
    const clicked = Date.now();
    // The peer's own clock when its DOM first held the node, without Playwright's trip back to the test.
    const seen = await to.waitForFunction((count) => document.querySelectorAll("[data-node-id][data-component]:not([data-node-id=root])").length >= count && Date.now(), i, { polling: "raf" });
    edits.push({ i, from, to, started, clicked, rendered: Number(await seen.jsonValue()), done: Date.now() });
  }
  const latencies = edits.map((edit) => edit.done - edit.started);
  // Where each edit's time went, read once every frame has arrived: click; the op leaves the editor; the room's
  // echo reaches the editor; the op reaches the peer; the peer's DOM shows it. "?" = that frame was not seen.
  const at = (list: Frame[] | undefined, dir: Frame["dir"], opId: string | undefined, after = 0): number | undefined => list?.find((f) => f.dir === dir && f.at >= after && (opId === undefined || f.opId === opId))?.at;
  const since = (from: number, to: number | undefined): string => (to === undefined ? "?" : String(to - from));
  const breakdown = edits.map(({ i, from, to, started, clicked, rendered }) => {
    const sent = frames.get(from)?.find((f) => f.dir === "sent" && f.at >= started);
    const echo = at(frames.get(from), "received", sent?.opId);
    const reached = at(frames.get(to), "received", sent?.opId);
    const route = from === page ? "first->second" : "second->first";
    return `#${String(i)} ${route} ${String(latencies[i - 1])} ms (click ${String(clicked - started)}, sent +${since(started, sent?.at)}, echo +${since(started, echo)}, peer frame +${since(started, reached)}, peer DOM +${String(rendered - started)})`;
  });
  const sorted = latencies.toSorted((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
  const summary = `local commit -> peer DOM: p50 ${String(sorted[12])} ms, p95 ${String(p95)} ms, max ${String(sorted.at(-1))} ms`;
  test.info().annotations.push({ type: "latency", description: summary }, { type: "latencies", description: latencies.join(", ") });
  await test.info().attach("edits", { body: breakdown.join("\n"), contentType: "text/plain" });
  await test.info().attach("console", { body: consoleLines.join("\n"), contentType: "text/plain" });
  process.stdout.write(`${summary}\n`); // in the gate's log on a green run too: how far under the limit it was
  // The message carries every edit, so a failure says which edits stalled and in which leg (the sync server
  // logs a journal call slower than 250 ms on stderr, which Playwright prints as [WebServer]).
  expect(p95, `${summary}\n${breakdown.join("\n")}`).toBeLessThan(200);

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
  await page.getByRole("option", { name: "Card", exact: true }).click();
  await page.getByRole("treeitem", { name: "Card 1", exact: true }).click();
  await page.getByRole("option", { name: "Button", exact: true }).click();
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
