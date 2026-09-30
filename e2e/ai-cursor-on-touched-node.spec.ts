import { twoBrowsersOnANewDocument } from "./editor.ts";
import { expect, test } from "./fixtures.ts";

// e2e:ai-cursor-on-touched-node (E10.6): the AI is a cursor too. It has no pointer, so its mark ("AI") sits on the
// node its last accepted op touched and moves as its ops arrive; when the run ends, the AI leaves and the mark goes.
// The model is scripted (e2e/stub-worker.ts: a Card, then N Buttons inside it, one every 400 ms).
const user = `e2e-${String(Date.now())}-ai-cursor@example.com`;

test("the AI's cursor appears on the other browser's canvas, labelled AI, on the node it last touched, and leaves with the run", async ({ page, browser }) => {
  const other = await twoBrowsersOnANewDocument(page, browser, user);

  await page.getByLabel("Ask the AI to change this page").fill("a card with 4 buttons");
  await page.getByRole("button", { name: "Ask the AI", exact: true }).click();

  // The AI is in the bar as what it is, with nothing to jump to (it never selects).
  const aiAvatar = other.getByRole("list", { name: "Also here" }).getByRole("button", { name: /AI agent/u });
  await expect(aiAvatar).toHaveCount(1);
  await expect(aiAvatar).toBeDisabled();

  // Its cursor: a mark labelled AI, anchored to a node (data-node), in the decorative layer.
  const aiCursor = other.locator("[data-presence-cursor][data-actor-kind=agent]");
  await expect(aiCursor).toHaveCount(1);
  await expect(aiCursor).toHaveText("AI");
  // It follows the ops: at some moment it sits on one of the Buttons the AI has just added...
  const buttonIds = () => other.locator("[data-node-id][data-component=Button]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-node-id")));
  await expect.poll(async () => { const at = await aiCursor.getAttribute("data-node"); return at !== null && (await buttonIds()).includes(at); }, { timeout: 10_000 }).toBe(true);
  // ...and is drawn inside that node's box (the Buttons sit inside the Card, so the Card's box holds it at every step).
  const card = await other.locator("[data-node-id][data-component=Card] > :first-child").boundingBox();
  const mark = await aiCursor.boundingBox();
  if (!card || !mark) throw new Error("no boxes");
  expect(mark.x).toBeGreaterThanOrEqual(card.x - 1);
  expect(mark.y).toBeGreaterThanOrEqual(card.y - 1);
  expect(mark.x).toBeLessThan(card.x + card.width);
  expect(mark.y).toBeLessThan(card.y + card.height);
  // The asker sees the same mark.
  await expect(page.locator("[data-presence-cursor][data-actor-kind=agent]")).toHaveText("AI");

  // The run ends: the AI leaves presence, and its cursor with it. What it made stays.
  await expect(page.locator("#ai-status")).toHaveAttribute("data-run-status", "succeeded", { timeout: 15_000 });
  await expect(aiCursor).toHaveCount(0, { timeout: 6000 });
  await expect(aiAvatar).toHaveCount(0);
  await expect(other.locator("[data-component=Card] [data-component=Button]")).toHaveCount(4);
  await expect(other.getByText("saved", { exact: true })).toBeVisible();
});
