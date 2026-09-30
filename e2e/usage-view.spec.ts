import { Org, Run } from "@noon/contracts";
import { expect, test } from "./fixtures.ts";

// e2e:usage-view (E9.5, F31). An owner and an editor each run the AI once (the e2e worker's scripted model reports
// 1,200 input and 340 output tokens and $0.0123 per run), and the owner's usage view shows, as text in tables, the
// totals, one row per person, one row for today (UTC) and one per run. axe checks the tables (fixtures.ts). The
// editor is refused, by the api and by the view.
const stamp = String(Date.now());
const owner = `e2e-${stamp}-usage-owner@example.com`;
const editor = `e2e-${stamp}-usage-editor@example.com`;
const password = "correct horse battery";
test.use({ allowedConsole: /status of 403\b/ }); // the editor's view is refused on purpose, at the end

test("an owner reads tokens and estimated cost per run, per person and per day; an editor may not", async ({ page, request }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in" });
  await form.getByLabel("Email").fill(owner);
  await form.getByLabel("Password").fill(password);
  await form.getByLabel("Name").fill("Uma");
  await form.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const documentId = new URL(page.url()).searchParams.get("doc") ?? "";

  // The runs through the api: the owner (the page's session cookie), then the editor (the development header).
  expect((await request.get("/api/auth/me", { headers: { "x-dev-user": editor } })).status()).toBe(200); // the dev header creates them
  const org = Org.parse(((await (await page.request.get("/api/orgs")).json()) as { items: unknown[] }).items[0]); // their only one
  expect((await page.request.put(`/api/orgs/${org.id}/members`, { data: { email: editor, role: "editor" } })).status()).toBe(200);
  const finished = async (res: Awaited<ReturnType<typeof request.post>>, headers: Record<string, string>): Promise<void> => {
    expect(res.status()).toBe(201);
    const run = Run.parse(await res.json());
    await expect.poll(async () => Run.parse(await (await page.request.get(`/api/documents/${documentId}/runs/${run.id}`, { headers })).json()).status, { timeout: 15_000 }).toBe("succeeded");
  };
  await finished(await page.request.post(`/api/documents/${documentId}/runs`, { data: { instruction: "0 buttons from the owner" } }), {});
  const asEditor = { "x-dev-user": editor };
  await finished(await request.post(`/api/documents/${documentId}/runs`, { data: { instruction: "0 buttons from the editor" }, headers: asEditor }), asEditor);

  await page.goto("/");
  await page.getByRole("link", { name: `AI usage of ${org.name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: `AI usage of ${org.name}`, exact: true })).toBeVisible();
  await expect(page.getByText("2 runs, 2,400 input tokens, 680 output tokens, $0.0246 estimated in all.")).toBeVisible();

  const byUser = page.getByRole("table", { name: "Per person, most expensive first" });
  await expect(byUser.locator("tbody tr")).toHaveCount(2);
  await expect(byUser.getByRole("rowheader")).toHaveText([owner, editor].sort()); // the same cost: by email
  for (const row of await byUser.locator("tbody tr").all()) await expect(row.getByRole("cell")).toHaveText(["1", "1,200", "340", "0", "0", "$0.0123"]);

  const byDay = page.getByRole("table", { name: "Per day (UTC), newest first" });
  await expect(byDay.getByRole("rowheader")).toHaveText([new Date().toISOString().slice(0, 10)]);
  await expect(byDay.locator("tbody tr").getByRole("cell")).toHaveText(["2", "2,400", "680", "0", "0", "$0.0246"]);

  const byRun = page.getByRole("table", { name: "Per run, newest first" });
  const rows = byRun.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(editor); // newest first
  await expect(rows.nth(1)).toContainText(owner);
  for (let i = 0; i < 2; i++) {
    await expect(rows.nth(i).getByRole("cell").nth(2)).toHaveText("scripted");
    await expect(rows.nth(i).getByRole("cell").nth(3)).toHaveText("1,200");
    await expect(rows.nth(i).getByRole("cell").nth(4)).toHaveText("340");
    await expect(rows.nth(i).getByRole("cell").nth(7)).toHaveText("$0.0123");
  }
  // The column headers name every number (a screen reader reads a cell with its header).
  await expect(byRun.getByRole("columnheader")).toHaveText(["When", "Who", "Document", "Model", "Input tokens", "Output tokens", "Cache read tokens", "Cache write tokens", "Estimated cost"]);

  // Owners only: the api refuses the editor, and so does the view.
  expect((await request.get(`/api/orgs/${org.id}/usage`, { headers: asEditor })).status()).toBe(403);
  expect((await page.request.post("/api/auth/signout")).status()).toBe(204);
  await page.goto(`/?usage=${org.id}&user=${encodeURIComponent(editor)}`);
  await expect(page.getByRole("alert")).toHaveText("Only an owner of this organisation can see what its AI runs cost.");
});
