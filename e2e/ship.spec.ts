import { expect, test } from "./fixtures.ts";
import { closePulls, documentWithButton, openPullsOf, pageInGitea, pageOf, pushPage, relabelled, welcomeOf } from "./gitea.ts";

// e2e:ship (F17, SPEC §8 step 9). The owner presses Ship twice, with a conflict banner up (an engineer pushed the
// page out of shape to the branch): exactly ONE open pull request in the dev stack's REAL Gitea holds the page,
// byte-identical to a fresh codegen of the final document. The REAL ship worker and git peer run from source
// (playwright.config.ts).
const user = `e2e-${String(Date.now())}-ship@example.com`;
test.setTimeout(90_000);

test("Ship twice with the conflict banner up: one open pull request, whose page is byte-identical to a fresh codegen of the final document", async ({ page, browser }) => {
  const { documentId, buttonId } = await documentWithButton(page, user);
  const broken = relabelled(buttonId, "From git").replace(/\{\n/u, "{\n  const [count] = useState(0);\n");
  const pushed = await pushPage(documentId, broken, "count clicks");
  try {
    // A new branch is found by the reconcile: opening the document asks for one.
    await welcomeOf(browser, page.url());
    await expect(page.getByRole("alert")).toContainText(pushed.commit, { timeout: 20_000 });

    const status = page.locator("[data-ship-status]");
    await page.getByRole("button", { name: "Ship", exact: true }).click();
    await expect(status).toHaveAttribute("data-ship-status", "succeeded", { timeout: 30_000 });
    const link = page.getByRole("link", { name: /^Pull request #\d+$/u });
    await expect(link).toBeVisible();
    const first = await openPullsOf(documentId);
    expect(first).toHaveLength(1);
    expect(await link.textContent()).toBe(`Pull request #${String(first[0]?.number)}`);
    expect(await pageInGitea(documentId)).toBe(pageOf((await welcomeOf(browser, page.url())).doc)); // on top of the broken page, back in shape
    // noon-wv8.6.1: and the canvas stops saying it is out of shape once the git peer has seen Ship's push.
    await expect(page.getByRole("alert").filter({ hasText: pushed.commit })).toHaveCount(0, { timeout: 40_000 });

    // An edit, and Ship again: the same pull request now holds the new page.
    await page.getByRole("option", { name: "Button", exact: true }).click();
    await expect(page.locator("[data-component=Button]")).toHaveCount(2);
    await expect(page.getByText("saved", { exact: true })).toBeVisible();
    const final = pageOf((await welcomeOf(browser, page.url())).doc);
    await page.getByRole("button", { name: "Ship", exact: true }).click();
    await expect.poll(() => pageInGitea(documentId), { timeout: 30_000 }).toBe(final);
    await expect(status).toHaveAttribute("data-ship-status", "succeeded", { timeout: 30_000 });
    const second = await openPullsOf(documentId);
    expect(second.map((pull) => pull.number)).toEqual(first.map((pull) => pull.number));
    expect(second[0]?.head.sha).not.toBe(first[0]?.head.sha);

    // Ship's own push is not read back as an engineer's edit: the canvas still has exactly its two buttons, unlabelled by git.
    await expect(page.locator("[data-component=Button]")).toHaveCount(2);
    await expect(page.locator("[data-component=Button] > .node-props").first()).toHaveText("label=Button");
  } finally {
    await closePulls(documentId);
    await pushed.remove();
  }
});
