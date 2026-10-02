import { Member } from "@noon/contracts";
import { expect, newDocument, test, uniqueStamp } from "./fixtures.ts";

// e2e:viewer-rejected (E8.2, F24): an owner invites a viewer; the viewer's browser shows the owner's edits and
// presence live, and its own attempted edit is refused, said in words, and undone on its canvas.
const stamp = uniqueStamp();
const owner = `e2e-${stamp}-owner@example.com`;
const viewer = `e2e-${stamp}-viewer@example.com`;

test("a viewer watches the owner edit live and sees its own edit refused", async ({ page, browser, request }) => {
  const { documentId, org } = await newDocument(page, owner);

  // The owner makes the other person a viewer of the org (through the api, as there is no screen for it yet).
  expect((await request.get(`/api/orgs`, { headers: { "x-dev-user": viewer } })).status()).toBe(200); // the dev header creates them
  const invited = await request.put(`/api/orgs/${org.id}/members`, { headers: { "x-dev-user": owner }, data: { email: viewer, role: "viewer" } });
  expect(Member.parse(await invited.json()).role).toBe("viewer");

  const watcher = await (await browser.newContext()).newPage();
  await watcher.goto(`/?user=${viewer}&doc=${documentId}`);
  await expect(watcher.getByRole("status")).toHaveText("live");
  await expect(watcher.getByRole("list", { name: "Also here" }).getByRole("listitem")).toContainText("e2e-"); // the owner's presence

  await page.getByRole("option", { name: "Card", exact: true }).click();
  await expect(watcher.locator("[data-component=Card]")).toHaveCount(1); // the owner's edit, live

  await watcher.getByRole("option", { name: "Card", exact: true }).click();
  await expect(watcher.getByRole("alert").filter({ hasText: "You can view this document but not edit it." })).toBeVisible();
  await expect(watcher.locator("[data-component=Card]")).toHaveCount(1); // its own card was undone
  await expect(page.locator("[data-component=Card]")).toHaveCount(1); // and never reached the owner
  await expect(watcher.getByText("saved", { exact: true })).toBeVisible(); // nothing left waiting
});
