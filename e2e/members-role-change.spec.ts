import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { MemberPage } from "@noon/contracts";
import { expect, newDocument, test, uniqueStamp } from "./fixtures.ts";

// e2e:members-role-change (E10.8, F24). From home, an owner opens their org's Members page, adds a person by email
// (by keyboard), changes their role, and is told in words when someone has not signed up and when the last owner
// cannot step down (never an error code). The same page, opened by a member who is not an owner, has no controls,
// and the api refuses them all the same. axe-clean in light and dark (the fixture checks the last theme shown).
const stamp = uniqueStamp();
const owner = `e2e-${stamp}-members-owner@example.com`;
const other = `e2e-${stamp}-members-other@example.com`;
const as = (email: string) => ({ headers: { "x-dev-user": email } });
test.use({ allowedConsole: /status of (404|409)\b/ }); // the unknown email and the last owner are refused on purpose; the browser logs each refusal
const axeClean = async (page: Page, theme: string): Promise<void> => {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), `no axe violations in ${theme}`).toEqual([]);
};

test("an owner adds a member and changes roles from the org page; the last owner is told so in words; another member reads it without controls", async ({ page, browser, request }) => {
  await page.emulateMedia({ colorScheme: "light" });
  expect((await request.get("/api/auth/me", as(other))).status()).toBe(200); // the dev header creates them, in no org
  const { org } = await newDocument(page, owner);
  const membersOf = async (): Promise<Record<string, string>> =>
    Object.fromEntries(MemberPage.parse(await (await request.get(`/api/orgs/${org.id}/members`, as(owner))).json()).items.map((m) => [m.email, m.role]));

  // Home lists the org; its Members page opens from there, and the bar's nav marks it as one of the org's three pages.
  await page.goto(`/?user=${owner}`);
  await page.getByRole("link", { name: `Members of ${org.name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: `Members of ${org.name}`, exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Organisation" }).getByRole("link", { name: "Members", exact: true })).toHaveAttribute("aria-current", "page");
  const rows = page.getByRole("table", { name: "Members, oldest first" }).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText(owner);
  const ownRole = page.getByLabel(`Role of ${owner}`);
  await expect(ownRole).toHaveValue("owner");

  // Add by email, by keyboard: Enter in the field submits.
  const form = page.getByRole("form", { name: "Add a member" });
  await form.getByLabel("Email").fill(other);
  await form.getByLabel("Role").selectOption("viewer");
  await form.getByLabel("Email").press("Enter");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText(other);
  const theirRole = page.getByLabel(`Role of ${other}`);
  await expect(theirRole).toHaveValue("viewer");
  await expect(form.getByLabel("Email")).toHaveValue(""); // ready for the next
  expect((await membersOf())[other]).toBe("viewer");

  // Someone nobody knows: a sentence, and the list is as it was.
  await form.getByLabel("Email").fill(`nobody-${stamp}@example.com`);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("Nobody has signed up with that email yet");
  await expect(rows).toHaveCount(2);

  // Their role, changed from the row's control: the api holds it at once.
  await theirRole.selectOption("editor");
  await expect(theirRole).toHaveValue("editor");
  await expect.poll(async () => (await membersOf())[other]).toBe("editor");

  // The last owner cannot step down: the control snaps back, and the row says why in words, never the api's name for it.
  await ownRole.selectOption("editor");
  const why = rows.nth(0).getByRole("alert");
  await expect(why).toContainText("must keep at least one owner");
  await expect(why).not.toContainText("last_owner");
  await expect(ownRole).toHaveValue("owner");
  expect((await membersOf())[owner]).toBe("owner");
  await axeClean(page, "light");
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await axeClean(page, "dark");

  // The other person, an editor now: the same page, the same list, and nothing to change it with.
  const theirs = await (await browser.newContext()).newPage();
  await theirs.goto(`/?user=${other}&org=${org.id}`);
  await expect(theirs.getByRole("heading", { name: `Members of ${org.name}`, exact: true })).toBeVisible();
  const theirRows = theirs.getByRole("table", { name: "Members, oldest first" }).locator("tbody tr");
  await expect(theirRows).toHaveCount(2);
  await expect(theirRows.nth(1)).toContainText("editor");
  await expect(theirs.getByRole("combobox")).toHaveCount(0);
  await expect(theirs.getByRole("form", { name: "Add a member" })).toHaveCount(0);
  // ...and the api refuses them all the same: the screen is not the guard.
  expect((await request.put(`/api/orgs/${org.id}/members`, { ...as(other), data: { email: owner, role: "viewer" } })).status()).toBe(403);
  await theirs.close();
});

// noon-2h1.8.3: who is an owner is the api's answer (GET /orgs/:orgId says the caller's role), not a search of the pages
// read so far. An owner whose own row sorts past the first page (50 members, oldest first) still gets the controls.
test("an owner whose own row is past the first page of members still gets an owner's controls", async ({ page, request }) => {
  const founder = `e2e-${stamp}-members-founder@example.com`;
  const late = `e2e-${stamp}-members-late@example.com`;
  const { org } = await newDocument(page, founder);
  for (let n = 0; n < 50; n++) {
    const email = `e2e-${stamp}-members-filler-${String(n)}@example.com`;
    expect((await request.get("/api/auth/me", as(email))).status()).toBe(200);
    expect((await request.put(`/api/orgs/${org.id}/members`, { ...as(founder), data: { email, role: "viewer" } })).status()).toBe(200);
  }
  expect((await request.get("/api/auth/me", as(late))).status()).toBe(200);
  expect((await request.put(`/api/orgs/${org.id}/members`, { ...as(founder), data: { email: late, role: "owner" } })).status()).toBe(200);

  await page.goto(`/?user=${late}&org=${org.id}`);
  await expect(page.getByRole("heading", { name: `Members of ${org.name}`, exact: true })).toBeVisible();
  const rows = page.getByRole("table", { name: "Members, oldest first" }).locator("tbody tr");
  await expect(rows).toHaveCount(50);
  await expect(rows.filter({ hasText: late })).toHaveCount(0); // their own row is on the next page
  await expect(page.getByText("You run this organisation")).toBeVisible();
  await expect(page.getByRole("form", { name: "Add a member" })).toBeVisible();
  await expect(page.getByLabel(`Role of ${founder}`)).toHaveValue("owner");
});
