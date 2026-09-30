import { createHash } from "node:crypto";
import type { Browser } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { documentWithButton, pushPage, relabelled, welcomeOf } from "./gitea.ts";

// e2e:conflict-banner-tree-unchanged (F16b). An engineer pushes the document's generated page out of shape to
// the dev stack's REAL Gitea; the REAL git peer refuses it whole. The room is exactly as it was (the tree's hash
// and its seq, as a fresh joiner is welcomed with them), the open canvas names the commit and the file, and
// editing goes on. Ship keeping working with the banner up is e2e/ship.spec.ts.
const user = `e2e-${String(Date.now())}-conflict@example.com`;
test.setTimeout(60_000);

/** JSON with every object's keys sorted: the same tree hashes the same whatever order its keys arrived in. */
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(value);

/** What the room holds NOW, as it welcomes a new peer: the tree's hash and the seq it has reached. Opening also asks the git peer to reconcile. */
async function roomState(browser: Browser, url: string): Promise<{ tree: string; seq: number }> {
  const { doc, seq } = await welcomeOf(browser, url);
  return { tree: createHash("sha256").update(canonical(doc)).digest("hex"), seq };
}

test("a push that breaks the page's shape changes nothing; the canvas names the commit and file, and editing goes on", async ({ page, browser }) => {
  const { documentId, buttonId, frames } = await documentWithButton(page, user);
  const before = await roomState(browser, page.url());
  expect(before.seq).toBeGreaterThan(0);

  // The engineer's edit: the label relabelled AND a hook added. In shape the relabel would land; out of shape, nothing may.
  const file = relabelled(buttonId, "From git");
  const broken = file.replace(/\{\n/u, "{\n  const [count] = useState(0);\n");
  expect(broken).not.toBe(file);
  const pushed = await pushPage(documentId, broken, "count clicks");
  try {
    // A new branch is found by the reconcile (the webhook ignores it): opening the document (roomState) asks for one.
    await roomState(browser, page.url());
    const banner = page.getByRole("alert");
    await expect(banner).toContainText(pushed.commit, { timeout: 20_000 });
    await expect(banner).toContainText(pushed.path);
    await expect(banner).toContainText("not applied");

    // Nothing changed: not the tree, not the seq, and no op ever came from git.
    expect(await roomState(browser, page.url())).toEqual(before);
    await expect(page.locator("[data-component=Button] > .node-props")).toHaveText("label=Button");
    const messages = frames.map((f) => JSON.parse(f) as { type: string; actor?: { kind: string } });
    expect(messages.filter((m) => m.type === "op" && m.actor?.kind === "git")).toEqual([]);

    // Editing keeps working, with the banner up.
    await page.getByRole("button", { name: "Add Button", exact: true }).click();
    await expect(page.locator("[data-component=Button]")).toHaveCount(2);
    await expect(page.getByText("saved", { exact: true })).toBeVisible();
    expect((await roomState(browser, page.url())).seq).toBe(before.seq + 1);
    await expect(banner).toContainText(pushed.commit);
  } finally {
    await pushed.remove();
  }
});
