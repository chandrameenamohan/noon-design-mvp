import { AxeBuilder } from "@axe-core/playwright";
import { test as base, expect } from "@playwright/test";

/**
 * Every e2e test gets two checks for free, after its own body:
 * the browser console stayed clean, and the page has no accessibility violations.
 */
export const test = base.extend<{ cleanPage: undefined }>({
  cleanPage: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") problems.push(`${msg.type()}: ${msg.text()}`);
      });
      page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));

      await use(undefined);

      expect(problems, "browser console must stay clean").toEqual([]);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.help}`), "no axe violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
