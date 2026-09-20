import { expect, test } from "vitest";
import { z } from "zod";
import { manifest } from "@noon/design-system";
import { probeTools } from "./sdk.ts";
import { buildTools, type AgentPeer, type AgentTool } from "./tools.ts";

// integration:agent-tools-registered. The REAL SDK and its real subprocess, stopped at the init
// message: that needs no credentials and costs nothing, so it runs everywhere, a clean clone included.
const nobody: AgentPeer = { submit: () => ({ ok: false, reason: "not_ready" }), get doc(): never { throw new Error("unused"); } };

test("the real SDK registers exactly our six tools and nothing else: no file, shell or web tool", async () => {
  const tools = buildTools(nobody, manifest);
  expect(tools.map((t) => t.name).sort()).toEqual(["add_node", "move_node", "read_manifest", "read_tree", "remove_node", "set_prop"]);
  await expect(probeTools(tools)).resolves.toBeUndefined();
}, 60_000);

test("a tool whose schema the SDK cannot convert (z.record) takes the WHOLE tool list down without a word: the probe says so", async () => {
  const poisoned: AgentTool = { name: "set_many", description: "sets several props", shape: { props: z.record(z.string(), z.unknown()) }, run: () => Promise.resolve({ ok: true, text: "" }) };
  await expect(probeTools([...buildTools(nobody, manifest), poisoned])).rejects.toMatchObject({ reason: "tools_missing" });
}, 60_000);
