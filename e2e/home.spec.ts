import { expect, test } from "./fixtures.ts";

test("home page renders and the contracts package is wired in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Noon MVP", exact: true })).toBeVisible();
  await expect(page.getByText("web: ok")).toBeVisible();
  await expect(page).toHaveScreenshot("home.png");
});
