import { expect, test } from "vitest";
import { MAX_RUN_STEPS, RunProgress, type RunStep } from "@noon/contracts";
import { stepOf, withProgress } from "./progress.ts";
import type { AgentTool } from "./tools.ts";

test("a step names the tool, whether it was applied, and what it was about", () => {
  expect(stepOf("add_node", { parentId: "root", component: "Button", props: {} }, true)).toEqual({ tool: "add_node", ok: true, detail: "Button" });
  expect(stepOf("set_prop", { nodeId: "n_1", key: "label", value: "Pay" }, false)).toEqual({ tool: "set_prop", ok: false, detail: "label" });
  expect(stepOf("remove_node", { nodeId: "n_1" }, true).detail).toBe("n_1");
  expect(stepOf("read_tree", {}, true).detail).toBe("");
});

test("the model's argument is untrusted: only a string, no invisible or control characters, never longer than the contract stores", () => {
  expect(stepOf("add_node", { component: 42 }, false).detail).toBe("");
  expect(stepOf("add_node", "not an object", false).detail).toBe("");
  expect(stepOf("add_node", JSON.parse('{"__proto__": {"component": "x"}}'), false).detail).toBe(""); // never an inherited value
  expect(stepOf("add_node", { component: "Bu‮tton\n\u0000" }, true).detail).toBe("Button");
  const long = stepOf("add_node", { component: "<script>".repeat(40) }, false);
  expect(long.detail).toHaveLength(80);
  expect(RunProgress.safeParse({ steps: [long] }).success).toBe(true); // text, whatever it says: the browser never parses it
});

test("every call is added in order and reported whole; only the last MAX_RUN_STEPS are kept", async () => {
  const echo: AgentTool = { name: "add_node", description: "", shape: {}, run: (args) => Promise.resolve({ ok: (args as { component: string }).component !== "Bad", text: "" }) };
  const seen: RunStep[][] = [];
  const [tool] = withProgress([echo], (steps) => seen.push(steps));
  if (!tool) throw new Error("no tool");
  expect(await tool.run({ component: "Card" })).toEqual({ ok: true, text: "" }); // the model gets the tool's own answer
  await tool.run({ component: "Bad" });
  expect(seen).toEqual([[{ tool: "add_node", ok: true, detail: "Card" }], [{ tool: "add_node", ok: true, detail: "Card" }, { tool: "add_node", ok: false, detail: "Bad" }]]);
  for (let i = 0; i < MAX_RUN_STEPS + 5; i++) await tool.run({ component: `C${String(i)}` });
  const last = seen.at(-1) ?? [];
  expect(last).toHaveLength(MAX_RUN_STEPS);
  expect(last.at(-1)?.detail).toBe(`C${String(MAX_RUN_STEPS + 4)}`);
  expect(RunProgress.safeParse({ steps: last }).success).toBe(true);
});
