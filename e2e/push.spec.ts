import { expect, test } from "./fixtures.ts";
import { documentWithButton, pushPage, relabelled } from "./gitea.ts";

// e2e:push-updates-canvas (F16a). An engineer pushes an edit of the generated page to the dev stack's REAL
// Gitea; the REAL git peer (apps/worker/src/main.ts, WORKER_QUEUE=git, from source: playwright.config.ts)
// turns it into ops through peer-client, and the open canvas shows them without a reload.
const user = `e2e-${String(Date.now())}-push@example.com`;
test.setTimeout(60_000);

test("a push that edits the page's generated file changes the open canvas, as git, without a reload", async ({ page, browser }) => {
  // Every frame the canvas receives: the ops must arrive stamped by the room as the git peer's.
  const { documentId, buttonId, frames } = await documentWithButton(page, user);
  await page.evaluate(() => { (window as unknown as { noonMark: string }).noonMark = "same load"; }); // a reload would lose it

  // Pushed to Gitea on the document's branch.
  const pushed = await pushPage(documentId, relabelled(buttonId, "From git"), "relabel the button");
  try {
    // A new branch is found by the reconcile (the webhook ignores it): opening the document asks for one now.
    const other = await (await browser.newContext()).newPage();
    await other.goto(page.url());
    await expect(other.getByRole("status")).toHaveText("live");

    await expect(page.locator("[data-component=Button] > .node-props")).toHaveText("label=From git", { timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { noonMark?: string }).noonMark)).toBe("same load");
    const ops = frames.map((f) => JSON.parse(f) as { type: string; actor?: { kind: string; runId?: string }; op?: unknown });
    expect(ops.filter((m) => m.type === "op" && m.actor?.kind === "git")).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ kind: "git", runId: pushed.commit }), op: { type: "set_prop", nodeId: buttonId, key: "label", value: "From git" } }),
    ]);
  } finally {
    await pushed.remove();
  }
});
