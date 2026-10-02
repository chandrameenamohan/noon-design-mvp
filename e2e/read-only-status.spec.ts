import type { WebSocketRoute } from "@playwright/test";
import { newDocument, tile } from "./editor.ts";
import { expect, test } from "./fixtures.ts";

// e2e:read-only-status (E6.1b, noon-mo3.2.1): what a person SEES when the room says it cannot save. The peer-client's
// readOnly flag is proven by the int test and the chaos check; this proves the screen: the bar's status says read-only,
// an alert explains it, and the library adds nothing; when the room can save again, all three go back.
// The room's word is stubbed: a status message injected into the real socket, so Postgres need not be stopped here.
const user = `e2e-${String(Date.now())}-read-only@example.com`;

test("the room's read-only status shows in the bar and as an alert, and the library adds nothing until it clears", async ({ page }) => {
  let room: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/documents\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => { server.send(message); });
    server.onMessage((message) => { ws.send(message); });
    room = ws;
  });
  await newDocument(page, user);
  const status = page.getByRole("status");
  const banner = page.getByRole("alert").filter({ hasText: "Read-only: the server cannot save edits right now." });
  const nodes = page.locator("[data-node-id][data-component]");
  await expect(nodes).toHaveCount(1); // the page alone
  await expect(banner).toHaveCount(0);

  if (!room) throw new Error("the document's socket was not routed");
  room.send(JSON.stringify({ type: "status", readOnly: true }));
  await expect(status).toHaveText("read-only");
  await expect(status).toHaveAttribute("data-read-only", "true");
  await expect(banner).toBeVisible();
  await expect(tile(page, "Card")).toHaveAttribute("aria-disabled", "true");
  await tile(page, "Card").click();
  await tile(page, "Card").press("Enter");
  await expect(nodes).toHaveCount(1); // nothing was added, by pointer or by keyboard

  room.send(JSON.stringify({ type: "status", readOnly: false }));
  await expect(status).toHaveText("live");
  await expect(banner).toHaveCount(0);
  await expect(tile(page, "Card")).not.toHaveAttribute("aria-disabled", /.*/);
  await tile(page, "Card").click();
  await expect(nodes).toHaveCount(2);
});
