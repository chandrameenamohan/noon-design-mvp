import { Member, Org } from "@noon/contracts";
import { expect, test } from "./fixtures.ts";

// e2e:audit-view (E8.4, F26). An owner signs in, and the org's audit trail lists, newest first, who did what and
// when: their sign-in, a role change, a share and its revoke, an AI run and a ship. What a person typed (the run's
// instruction, markup included) shows as text, never as markup; axe checks the table (fixtures.ts). A rejected push
// is listed too: integration:audit-written-all-event-types writes one through the git peer's store.
const stamp = String(Date.now());
const owner = `e2e-${stamp}-audit-owner@example.com`;
const editor = `e2e-${stamp}-audit-editor@example.com`;
const outsider = `e2e-${stamp}-audit-outsider@example.com`;
const password = "correct horse battery";
const instruction = `<img src=x onerror="document.title='owned'"> a pricing card ${stamp}`;

test("an owner reads who signed in, changed roles and shares, ran the AI and shipped, and when", async ({ page, request }) => {
  // Signed up and back in through the form: the second sign-in is the one the org hears of (it had no org before).
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in" });
  await form.getByLabel("Email").fill(owner);
  await form.getByLabel("Password").fill(password);
  await form.getByLabel("Name").fill("Audra");
  await form.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const documentId = new URL(page.url()).searchParams.get("doc") ?? "";
  await page.goto("/");
  // Home asks for the orgs once it knows who this is: signing out under that request makes it a 401 the browser logs.
  await expect(page.getByRole("heading", { name: "Your organisations", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await form.getByLabel("Email").fill(owner);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as Audra (${owner})`)).toBeVisible();

  // The rest through the api, as the owner (page.request carries the page's session cookie).
  for (const email of [editor, outsider]) expect((await request.get("/api/auth/me", { headers: { "x-dev-user": email } })).status()).toBe(200); // the dev header creates them
  const org = Org.parse(((await (await page.request.get("/api/orgs")).json()) as { items: unknown[] }).items[0]); // their only one
  expect((await page.request.put(`/api/orgs/${org.id}/members`, { data: { email: editor, role: "editor" } })).status()).toBe(200);
  const share = await page.request.put(`/api/documents/${documentId}/shares`, { data: { email: outsider, role: "viewer" } });
  expect(share.status()).toBe(200);
  const { userId } = Member.parse(await share.json());
  expect((await page.request.delete(`/api/documents/${documentId}/shares/${userId}`)).status()).toBe(204);
  expect((await page.request.post(`/api/documents/${documentId}/runs`, { data: { instruction } })).status()).toBe(201);
  expect((await page.request.post(`/api/documents/${documentId}/ship`)).status()).toBe(201);

  // From home, the org's audit trail.
  await page.reload();
  await page.getByRole("link", { name: `Audit trail of ${org.name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: `Audit trail of ${org.name}`, exact: true })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  const rows = table.locator("tbody tr");
  // Newest first; each row says who, what, and when.
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toContainText("Started a ship.");
  await expect(rows.nth(1)).toContainText(`Started an AI run: “${instruction}”`);
  await expect(rows.nth(2)).toContainText(`Revoked the share of ${outsider}.`);
  await expect(rows.nth(3)).toContainText(`Shared a document with ${outsider} as viewer.`);
  await expect(rows.nth(4)).toContainText(`Added ${editor} as editor.`);
  await expect(rows.nth(5)).toContainText("Signed in.");
  for (let i = 0; i < 6; i++) {
    await expect(rows.nth(i).getByRole("cell").nth(1)).toHaveText(owner);
    const when = await rows.nth(i).locator("time").getAttribute("datetime");
    expect(Math.abs(Date.parse(when ?? "") - Date.now())).toBeLessThan(5 * 60_000);
  }
  // The instruction's markup stayed text: no image was made of it, and its script never ran.
  await expect(table.locator("img")).toHaveCount(0);
  expect(await page.title()).not.toBe("owned");

  // Owners only: once the editor (a member, not an owner) asks, the api refuses them.
  expect((await request.get(`/api/orgs/${org.id}/audit`, { headers: { "x-dev-user": editor } })).status()).toBe(403);
});
