import { AxeBuilder } from "@axe-core/playwright";
import { test as base, expect } from "@playwright/test";

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
