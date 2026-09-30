import { MAX_RUN_STEPS, type RunStep } from "@noon/contracts";
import type { AgentTool } from "./tools.ts";

// Which argument says what a call was about. The rest (props, index) is detail the panel does not need.
const SUBJECT: Partial<Record<string, string>> = { add_node: "component", set_prop: "key", move_node: "nodeId", remove_node: "nodeId" };

/**
 * F30: one tool call as the panel shows it. The subject is the MODEL's own argument, so it is untrusted text: only a
 * string is taken, invisible and control characters go (a bidi override could make a line read as something else),
 * and it is cut to what the contract stores. The browser shows it as text.
 */
export function stepOf(tool: string, args: unknown, ok: boolean): RunStep {
  const key = SUBJECT[tool];
  const raw = key !== undefined && typeof args === "object" && args !== null && Object.hasOwn(args, key) ? (args as Record<string, unknown>)[key] : undefined;
  return { tool, ok, detail: typeof raw === "string" ? raw.replace(/\p{C}/gu, "").slice(0, 80) : "" };
}

/**
 * The same tools, each call also added to the run's steps; `onSteps` gets the whole list (the last MAX_RUN_STEPS)
 * after every call, so a write that fails is made good by the next one.
 */
export function withProgress(tools: AgentTool[], onSteps: (steps: RunStep[]) => void): AgentTool[] {
  const steps: RunStep[] = [];
  return tools.map((t) => ({
    ...t,
    run: async (args) => {
      const result = await t.run(args);
      steps.push(stepOf(t.name, args, result.ok));
      if (steps.length > MAX_RUN_STEPS) steps.shift();
      onSteps([...steps]);
      return result;
    },
  }));
}
