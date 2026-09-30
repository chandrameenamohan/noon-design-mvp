import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { MemberPage, Org } from "@noon/contracts";
import { expect, test } from "./fixtures.ts";

// e2e:share-dialog (E10.8, F25). The owner's Share in the top bar opens a modal dialog: they share the document with
// someone outside the org by email (by keyboard), the outsider gets in live and edits; the owner changes the share to
// viewer and the outsider's next edit is refused; the owner revokes (a confirmation first: Keep leaves it) and the
// outsider's session closes for good. Escape closes the dialog and gives the Share button its focus back. A viewer of
// the org sees no Share at all, and the api refuses them the list regardless. axe-clean with the dialog up, in both themes.
const stamp = String(Date.now());
const owner = `e2e-${stamp}-share-owner@example.com`;
const outsider = `e2e-${stamp}-share-outsider@example.com`;
const viewer = `e2e-${stamp}-share-viewer@example.com`;
const as = (email: string) => ({ headers: { "x-dev-user": email } });
test.use({ allowedConsole: /status of 404\b/ }); // the unknown email is refused on purpose; the browser logs the refusal
const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Share this document" });
const focusInDialog = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest("dialog") !== null && document.activeElement !== document.body);
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};
/** A fresh document of the owner's (an org of their own comes with it), live, and its id. */
async function newDocument(page: Page): Promise<string> {
  await page.goto(`/?user=${owner}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const id = new URL(page.url()).searchParams.get("doc");
  if (id === null) throw new Error("no document in the address");
  return id;
}

test("the owner shares from the bar's dialog; the outsider edits live, is made a viewer, then revoked after a confirmation and their session closes; a viewer has no Share", async ({ page, browser, request }) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const email of [outsider, viewer]) expect((await request.get("/api/auth/me", as(email))).status()).toBe(200); // the dev header creates them
  const documentId = await newDocument(page);
  const sharesNow = async (): Promise<Record<string, string>> =>
    Object.fromEntries(MemberPage.parse(await (await request.get(`/api/documents/${documentId}/shares`, as(owner))).json()).items.map((m) => [m.email, m.role]));

  // Share, by keyboard: a modal dialog, focus inside, nobody shared with yet.
  const share = page.getByRole("button", { name: "Share", exact: true });
  await share.focus();
  await page.keyboard.press("Enter");
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  expect(await focusInDialog(page)).toBe(true);
  await expect(dialog.getByText("Not shared with anyone outside the organisation yet.")).toBeVisible();
  await page.keyboard.press("p"); // the global preview toggle: nothing, a modal is up
  await expect(page.getByRole("region", { name: "Preview" })).toHaveCount(0);

  // With the outsider, as editor: Enter in the email field submits.
  const form = dialog.getByRole("form", { name: "Share with someone" });
  await form.getByLabel("Email").fill(outsider);
  await form.getByLabel("Role").selectOption("editor");
  await form.getByLabel("Email").press("Enter");
  const rows = dialog.getByRole("table", { name: "Shared with" }).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText(outsider);
  const theirRole = dialog.getByLabel(`Role of ${outsider}`);
  await expect(theirRole).toHaveValue("editor");
  expect(await sharesNow()).toEqual({ [outsider]: "editor" });
  // Someone nobody knows: a sentence, and the list is as it was.
  await form.getByLabel("Email").fill(`nobody-${stamp}@example.com`);
  await form.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nobody has signed up with that email yet");
  await expect(rows).toHaveCount(1);
  await axeClean(page, "light");

  // The outsider opens it live and edits; an editor's share gives them no Share of their own.
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/?user=${outsider}&doc=${documentId}`);
  await expect(guest.getByRole("status")).toHaveText("live");
  await expect(guest.getByRole("button", { name: "Ship", exact: true })).toBeVisible();
  await expect(guest.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  await guest.getByRole("option", { name: "Card", exact: true }).click();
  await expect(page.locator("[data-component=Card]")).toHaveCount(1); // accepted, and live at the owner's

  // Made a viewer from the dialog: the api holds it at once, and within F24's 10 s the room refuses their next edit.
  await theirRole.selectOption("viewer");
  await expect(theirRole).toHaveValue("viewer");
  expect(await sharesNow()).toEqual({ [outsider]: "viewer" });
  const refused = guest.getByRole("alert").filter({ hasText: "You can view this document but not edit it." });
  await expect.poll(async () => {
    await guest.getByRole("option", { name: "Card", exact: true }).click();
    return refused.count();
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  // Revoke asks first. Keep leaves the share and gives the button its focus back; Revoke, confirmed by keyboard, removes it.
  const revoke = dialog.getByRole("button", { name: `Revoke the access of ${outsider}`, exact: true });
  await revoke.click();
  const confirm = dialog.getByRole("group", { name: `Confirm revoking the access of ${outsider}` });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Revoke", exact: true })).toBeFocused();
  await confirm.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(revoke).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm.getByRole("button", { name: "Revoke", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(0);
  await expect(dialog.getByText("Not shared with anyone outside the organisation yet.")).toBeVisible();
  await expect(form.getByLabel("Email")).toBeFocused(); // the row is gone; focus stays in the dialog
  expect(await sharesNow()).toEqual({});

  // The outsider's session closes, and the way back is refused (E8.3).
  await expect(guest.getByRole("alert")).toContainText("This document cannot be opened", { timeout: 10_000 });
  await expect(guest.getByRole("status")).toHaveCount(0);
  expect((await request.post(`/api/documents/${documentId}/session`, as(outsider))).status()).toBe(404);
  await guest.close();

  // Escape closes the dialog and the Share button has focus again. Dark: the dialog is clean there too.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(share).toBeFocused();
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await share.click();
  await expect(dialog).toBeVisible();
  await axeClean(page, "dark");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A viewer of the org opens the document without a Share in the bar; the api refuses them the list all the same.
  const org = Org.parse(((await (await request.get("/api/orgs", as(owner))).json()) as { items: unknown[] }).items.at(-1));
  expect((await request.put(`/api/orgs/${org.id}/members`, { ...as(owner), data: { email: viewer, role: "viewer" } })).status()).toBe(200);
  const watcher = await (await browser.newContext()).newPage();
  await watcher.goto(`/?user=${viewer}&doc=${documentId}`);
  await expect(watcher.getByRole("status")).toHaveText("live");
  await expect(watcher.getByRole("button", { name: "Ship", exact: true })).toBeVisible();
  await expect(watcher.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  expect((await request.get(`/api/documents/${documentId}/shares`, as(viewer))).status()).toBe(403);
  await watcher.close();
});
