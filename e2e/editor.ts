import { AxeBuilder } from "@axe-core/playwright";
import type { Browser, Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * The editor as the e2e specs reach it: one locator per landmark the shell exposes, the canvas's tree as a
 * string, and the two openings every collaboration spec starts with. Kept here so a renamed role or label
 * changes in one place (noon-92o).
 */
export const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A component in the library (E10.5): a click adds it into the selection, as the "Add X" buttons did. */
export const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
export const layer = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
export const heading = (page: Page) => page.getByRole("complementary", { name: "Selected element" }).getByRole("heading", { level: 2 });
export const zoomOf = async (page: Page): Promise<number> => Number(await page.locator(".world").getAttribute("data-zoom"));

export type Box = { x: number; y: number; width: number; height: number };
export const box = async (page: Page, selector: string): Promise<Box> => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
};
/** The middle of a node's own element (its wrapper has no box): where a person would click it. */
export const centreOf = async (page: Page, component: string): Promise<{ x: number; y: number }> => {
  const b = await box(page, `[data-node-id][data-component=${component}] > :first-child`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** A spot on the sheet with nothing on it: the fitted frame leaves a margin, and its top-left corner is outside the frame. */
export const emptySpot = async (page: Page): Promise<{ x: number; y: number }> => { const c = await box(page, ".canvas"); return { x: c.x + 12, y: c.y + 12 }; };

/** The page's direct children on the canvas, in order. */
export const pageChildren = (page: Page) => page.locator(".page-frame > [data-node-id]");
export const componentsOf = async (rows: Locator): Promise<string[]> => rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-component") ?? ""));
/** The canvas's tree as nested [component, children]. A layers row (E10.3) carries data-node-id too and comes first
 * in the page, so every selector names the canvas's nodes (data-component), or the root lookup finds a row and prints "[]". */
export const treeOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const walk = (el: Element): unknown => [...el.querySelectorAll("[data-node-id][data-component]")].filter((child) => child.parentElement?.closest("[data-node-id]") === el).map((child) => [child.getAttribute("data-component"), walk(child)]);
    const root = document.querySelector("[data-node-id=root][data-component]");
    return JSON.stringify(root ? walk(root) : "no root");
  });

export const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};
/** Axe on the page as it is (the spec put it in light), then again after the bar's Dark theme. */
export const axeCleanLightAndDark = async (page: Page): Promise<void> => {
  await axeClean(page, "light");
  await button(page, "Dark theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await axeClean(page, "dark");
};

/** Signs `user` in, makes a new document and waits until it is live. */
export async function newDocument(page: Page, user: string): Promise<void> {
  await page.goto(`/?user=${user}`);
  await button(page, "New document").click();
  await expect(page.getByRole("status")).toHaveText("live");
}
/** `newDocument`, then a second browser on the same document, live; returns that other page. */
export async function twoBrowsersOnANewDocument(page: Page, browser: Browser, user: string): Promise<Page> {
  await newDocument(page, user);
  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.getByRole("status")).toHaveText("live");
  return other;
}
