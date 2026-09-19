// Prints a handbook page to PDF with headless Chromium.  Usage: node docs/handbook/make-pdf.mjs lesson-0
// The quiz is interactive on the web; on paper the answers are revealed and marked instead.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const name = process.argv[2];
if (!name) throw new Error("usage: node docs/handbook/make-pdf.mjs <lesson-name>");
const here = new URL("./", import.meta.url);
const body = await readFile(new URL(`${name}.html`, here), "utf8");
const wrapped = join(tmpdir(), `${name}-print.html`);
await writeFile(wrapped, `<!doctype html><html><head><meta charset="utf8"></head><body>${body}</body></html>`);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.emulateMedia({ media: "print", colorScheme: "light" });
await page.goto(`file://${wrapped}`, { waitUntil: "networkidle" });
await page.evaluate(() => {
  document.documentElement.dataset.theme = "light";
  for (const d of document.querySelectorAll("details")) d.open = true;
  for (const b of document.querySelectorAll(".quiz button[data-correct]")) b.classList.add("right");
  for (const w of document.querySelectorAll(".quiz .why")) w.hidden = false;
});
const out = new URL(`${name}.pdf`, here);
await page.pdf({
  path: out.pathname, format: "A4", printBackground: true,
  margin: { top: "18mm", bottom: "18mm", left: "17mm", right: "17mm" },
  displayHeaderFooter: true, headerTemplate: "<span></span>",
  footerTemplate: `<div style="font:8px monospace;color:#777;width:100%;text-align:center">Noon MVP handbook · ${name} · <span class="pageNumber"></span>/<span class="totalPages"></span></div>`,
});
await browser.close();
process.stdout.write(`wrote ${out.pathname}\n`);
