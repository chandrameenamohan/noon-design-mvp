import { expect, test } from "vitest";
import { stepText } from "./progress.ts";

test("a step reads as what the AI did, and says so when it was not applied", () => {
  expect(stepText({ tool: "add_node", ok: true, detail: "Button" })).toBe("Added Button");
  expect(stepText({ tool: "set_prop", ok: false, detail: "label" })).toBe("Set label: not applied");
  expect(stepText({ tool: "read_tree", ok: true, detail: "" })).toBe("Read the page");
});

test("a tool this build has never heard of is shown by its name; the model's words stay as they are (text, not markup)", () => {
  expect(stepText({ tool: "resize_node", ok: true, detail: "" })).toBe("resize_node");
  expect(stepText({ tool: "add_node", ok: true, detail: "<img src=x onerror=alert(1)>" })).toBe("Added <img src=x onerror=alert(1)>");
  expect(stepText({ tool: "constructor", ok: true, detail: "" })).toBe("constructor"); // never Object.prototype's
});
