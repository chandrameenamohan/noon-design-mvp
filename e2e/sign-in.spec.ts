import { expect, test } from "./fixtures.ts";

// e2e:sign-in (E8.1, F23). No ?user= anywhere: the browser is who it signed in as, through the session cookie.
const email = `e2e-${String(Date.now())}-sign-in@example.com`;
const password = "correct horse battery";

// A wrong password (401) and a taken email (409) are failed requests the browser logs; they are the point here.
test.use({ allowedConsole: /status of (401|409)\b/ });

test("sign up, open a document live, sign out, and signing back in takes the right password only", async ({ page, browser }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in" });
  await expect(form).toBeVisible();
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(password);
  await form.getByLabel("Name").fill("Signe");
  await form.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByText(`Signed in as Signe (${email})`)).toBeVisible();

  // The cookie carries the person into a live document: /session, then the room.
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const documentUrl = page.url();

  // Another browser, never signed in, gets nothing from the same address.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(documentUrl);
  await expect(stranger.getByRole("alert")).toContainText("This document cannot be opened");
  await stranger.close();

  // Still signed in after a reload; then out.
  await page.goto("/");
  await expect(page.getByText(`Signed in as Signe (${email})`)).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(form).toBeVisible();
  await page.reload();
  await expect(form).toBeVisible(); // the session is gone on the server, not only on this page

  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill("wrong horse battery");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("That email and password do not match an account.");

  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as Signe (${email})`)).toBeVisible();
  await page.goto(documentUrl);
  await expect(page.getByRole("status")).toHaveText("live");
});

test("signing up with an email that has an account says so, and signs nobody in", async ({ page }) => {
  const taken = `e2e-${String(Date.now())}-taken@example.com`;
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in" });
  for (const attempt of [1, 2]) {
    await form.getByLabel("Email").fill(taken);
    await form.getByLabel("Password").fill(password);
    await form.getByLabel("Name").fill("Taken");
    await form.getByRole("button", { name: "Sign up", exact: true }).click();
    if (attempt === 1) {
      await expect(page.getByText("Signed in as Taken")).toBeVisible();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
    }
  }
  await expect(form.getByRole("alert")).toHaveText("An account with that email already exists. Sign in instead.");
});
