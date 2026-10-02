import { AxeBuilder } from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import { Org } from "@noon/contracts";

/**
 * Every e2e test gets two checks for free, after its own body:
 * the browser console stayed clean, and the page has no accessibility violations.
 */
export const test = base.extend<{ cleanPage: undefined; allowedConsole: RegExp | undefined }>({
  /**
   * Console lines a test EXPECTS (a deliberate 404, going offline): `test.use({ allowedConsole: /.../ })`.
   * ONE RegExp, not a list: Playwright reads an array given to test.use() as its own [value, options] pair.
   */
  allowedConsole: [undefined, { option: true }],
  cleanPage: [
    async ({ page, allowedConsole }, use) => {
      const problems: string[] = [];
      page.on("console", (msg) => {
        if ((msg.type() === "error" || msg.type() === "warning") && !allowedConsole?.test(msg.text())) problems.push(`${msg.type()}: ${msg.text()}`);
      });
      page.on("pageerror", (err) => { if (!allowedConsole?.test(err.message)) problems.push(`pageerror: ${err.message}`); });

      await use(undefined);

      expect(problems, "browser console must stay clean").toEqual([]);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.help}`), "no axe violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * What a spec puts in the emails it makes up. Not the time alone: two workers can load a spec in the same millisecond,
 * and would then share its users and their orgs (noon-phd).
 */
export const uniqueStamp = (): string => `${String(Date.now())}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * `user` makes a document from home (an org of its own comes with it) and it is live. The org is the one THIS click
 * made, read from the page's own request: a user's orgs listed by position is someone else's when users collide (noon-phd).
 */
export async function newDocument(page: Page, user: string): Promise<{ documentId: string; org: Org }> {
  await page.goto(`/?user=${user}`);
  const made = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/orgs");
  await page.getByRole("button", { name: "New document", exact: true }).click();
  const org = Org.parse(await (await made).json());
  await expect(page.getByRole("status")).toHaveText("live");
  const documentId = new URL(page.url()).searchParams.get("doc");
  if (documentId === null) throw new Error("no document in the address");
  return { documentId, org };
}
