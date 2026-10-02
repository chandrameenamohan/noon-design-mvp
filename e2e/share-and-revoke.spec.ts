import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Member, SessionResponse } from "@noon/contracts";
import { expect, test, uniqueStamp } from "./fixtures.ts";

// e2e:share-and-revoke-reconnect-refused (E8.3, F25): the owner shares a document with someone outside the org, at
// editor; both edit live. The owner revokes the share: the outsider's page closes, gets no further edits, and every
// way back is refused: a new session is 404, and a token minted before the revoke (it lives 60 s) is 401 at the upgrade.
const stamp = uniqueStamp();
const owner = `e2e-${stamp}-owner@example.com`;
const outsider = `e2e-${stamp}-outsider@example.com`;

/** The HTTP status the sync server answers a WebSocket upgrade with (101: it opened one). */
function upgradeStatus(wsUrl: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(wsUrl.replace(/^ws/, "http"), {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-protocol": `noon.v1, ${token}` },
    });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
    req.on("error", reject);
    req.end();
  });
}

test("an outsider edits a shared document live; revoked, their page closes, sees no further edits, and cannot come back", async ({ page, browser, request }) => {
  const as = (email: string) => ({ headers: { "x-dev-user": email } });
  expect((await request.get(`/api/auth/me`, as(outsider))).status()).toBe(200); // the dev header creates them, in no org
  await page.goto(`/?user=${owner}`);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("live");
  const documentId = new URL(page.url()).searchParams.get("doc") ?? "";
  expect(documentId).not.toBe("");

  // The owner shares the document with them (through the api, as there is no screen for it yet).
  const shared = Member.parse(await (await request.put(`/api/documents/${documentId}/shares`, { ...as(owner), data: { email: outsider, role: "editor" } })).json());
  expect(shared.role).toBe("editor");

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/?user=${outsider}&doc=${documentId}`);
  await expect(guest.getByRole("status")).toHaveText("live");
  await page.getByRole("option", { name: "Card", exact: true }).click();
  await expect(guest.locator("[data-component=Card]")).toHaveCount(1); // the owner's edit, live
  await guest.getByRole("option", { name: "Card", exact: true }).click();
  await expect(page.locator("[data-component=Card]")).toHaveCount(2); // and the outsider's, accepted

  const early = SessionResponse.parse(await (await request.post(`/api/documents/${documentId}/session`, as(outsider))).json());
  expect((await request.delete(`/api/documents/${documentId}/shares/${shared.userId}`, as(owner))).status()).toBe(204);

  await expect(guest.getByRole("alert")).toContainText("This document cannot be opened", { timeout: 10_000 }); // within F24's 10 s
  await page.getByRole("option", { name: "Card", exact: true }).click();
  await expect(page.locator("[data-component=Card]")).toHaveCount(3);
  await expect(guest.locator("[data-component=Card]")).toHaveCount(0); // no canvas, no further ops
  await expect(guest.getByRole("status")).toHaveCount(0); // and no connection trying to come back

  expect((await request.post(`/api/documents/${documentId}/session`, as(outsider))).status()).toBe(404);
  expect(await upgradeStatus(early.wsUrl, early.token), "a token minted before the revoke").toBe(401);
  await guest.reload(); // a reconnect by hand: /session is a 404, and the page says so
  await expect(guest.getByRole("alert")).toContainText("This document cannot be opened");
});
