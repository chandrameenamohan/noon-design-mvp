import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Doc, Manifest, Op } from "@noon/contracts";
import { nodeOf } from "@noon/doc-model";
import type { connectPeer } from "@noon/peer-client";

/** The slice of a peer the tools need. Everything the agent changes goes through submit(): the single write path. */
export type AgentPeer = Pick<ReturnType<typeof connectPeer>, "submit" | "doc">;
type ToolResult = { ok: boolean; text: string };
/** One tool, independent of the SDK: `shape` is what the model is told, `run` is what happens. */
export type AgentTool = { name: string; description: string; shape: z.ZodRawShape; run(args: unknown): Promise<ToolResult> };

// What the MODEL is shown. Deliberately plain: the Agent SDK cannot convert every Zod schema, and
// one it cannot convert removes the whole tool list in silence (SPEC §2a; z.record is such a shape,
// which is why props is an object with a catchall). These are hints, not the gate: every op is
// validated by the contract, the replica and the room, exactly like a person's.
const value = z.union([z.string(), z.number(), z.boolean()]);
const nodeId = z.string().describe("the id of an existing node; the root's id is \"root\"");

const ok = (result: unknown): ToolResult => ({ ok: true, text: JSON.stringify(result) });
const refused = (reason: string, hint = ""): ToolResult => ({ ok: false, text: `Not applied: ${reason}.${hint === "" ? "" : ` ${hint}`}` });

/** The tree as the model reads it: nested, so structure is visible without following ids. */
function outline(doc: Doc, id: string): unknown {
  const node = nodeOf(doc, id); // never doc.nodes[id]: "constructor" would find Object.prototype's
  if (!node) return undefined;
  return { id: node.id, component: node.component, props: node.props, children: node.children.map((child) => outline(doc, child)) };
}

/**
 * The agent's whole world: the four ops, the tree, the manifest. No file, shell or web tool exists.
 * `mintNodeId`: where add_node's ids come from. An AI run mints them per (job, step), so an attempt retried after a
 * crash (F28) adds the nodes the dead attempt added under the same ids, and the room keeps one of each.
 */
export function buildTools(peer: AgentPeer, manifest: Manifest, mintNodeId: () => string = () => `n_${randomBytes(6).toString("hex")}`): AgentTool[] {
  const components = manifest.components.map((c) => c.name).join(", ");
  // A Map, not an object: a reason named "constructor" must find nothing, not Object.prototype's.
  const hints = new Map(Object.entries({
    unknown_component: `Valid components: ${components}.`,
    unknown_prop: "Call read_manifest for the props each component takes.",
    wrong_prop_type: "Call read_manifest for the type of each prop.",
    missing_required_prop: "Call read_manifest for the required props.",
    parent_takes_no_children: "Only components whose manifest entry says acceptsChildren can be a parent.",
    gone: "That node (or parent) does not exist now: call read_tree; someone may have removed it.",
    document_limit: "The document is full or too deep. Do not add more nodes; finish with what is there.",
    connection_closed: "The connection to the document is gone. Stop: no further edit can be applied.",
    read_only: "The document is read-only: the server cannot save edits right now. Stop and report that the edit could not be made.",
  }));

  /**
   * One op, start to finish: the replica's verdict, then the ROOM's. Either refusal is a tool error (F11).
   * `replayed`: asked when the replica says the node already exists. True = this step's node, added by an
   * earlier attempt of the same run: the step is done, not refused.
   */
  async function apply(op: Op, done: unknown, replayed = (): boolean => false): Promise<ToolResult> {
    const submitted = peer.submit(op);
    if (!submitted.ok && submitted.reason === "duplicate_node" && replayed()) return ok(done);
    if (!submitted.ok) return refused(submitted.reason, hints.get(submitted.reason));
    const outcome = await submitted.settled;
    return outcome.ok ? ok(done) : refused(outcome.reason, hints.get(outcome.reason));
  }

  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>): AgentTool => ({
    name,
    description,
    shape,
    // The model's arguments are input from outside like any other: parsed here, whatever the SDK did before.
    run: async (args) => {
      try {
        // Zod quietly DROPS an own "__proto__" key: the tool would report success for a prop that was never
        // set. Refuse it on the raw input, one level down too (that is where `props` lives).
        const smuggled = (raw: unknown): boolean => typeof raw === "object" && raw !== null && (Object.hasOwn(raw, "__proto__") || Object.values(raw).some(smuggled));
        if (smuggled(args)) return refused("invalid_arguments", "__proto__ is a reserved name.");
        const parsed = z.strictObject(shape).safeParse(args);
        return parsed.success ? await run(parsed.data) : refused("invalid_arguments", parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; "));

      } catch (err) {
        // A tool ANSWERS, whatever it was handed: arguments nested deeper than the stack (a model can emit that) land here.
        return refused("invalid_arguments", err instanceof RangeError ? "nested too deeply" : "could not be read");
      }
    },
  });

  return [
    tool("read_tree", "Returns the current document as a nested tree of nodes (id, component, props, children).", {}, () => Promise.resolve(ok(outline(peer.doc, peer.doc.rootId)))), // ponytail: the whole tree, every time; a subtree argument when documents outgrow the context window
    tool("read_manifest", "Returns the components that may be placed, the props each one takes (name, type, required, default) and whether it accepts children.", {}, () => Promise.resolve(ok(manifest.components))),
    tool(
      "add_node",
      `Adds a component instance under a parent and returns its new nodeId. Components: ${components}.`,
      { parentId: nodeId, component: z.string(), props: z.object({}).catchall(value).default({}).describe("prop name -> value; may be omitted"), index: z.number().int().optional().describe("position among the parent's children; omit to append") },
      ({ parentId, component, props, index }) => {
        const id = mintNodeId(); // the tool mints ids: a model would reuse "card1" across runs
        // Same component: the dead attempt's node for this step (a model that changed its mind gets the refusal, and a new
        // id next time). Not the parent: the dead attempt may have moved it since, and refusing would add it twice (noon-elo.2.2).
        const replayed = (): boolean => nodeOf(peer.doc, id)?.component === component;
        return apply({ type: "add_node", nodeId: id, parentId, component, props, index: index ?? nodeOf(peer.doc, parentId)?.children.length ?? 0 }, { nodeId: id }, replayed);
      },
    ),
    tool("set_prop", "Sets one prop of a node. A null value removes the prop, so the component's default applies.", { nodeId, key: z.string(), value: value.nullable() }, ({ nodeId: id, key, value: next }) =>
      apply({ type: "set_prop", nodeId: id, key, value: next }, { nodeId: id, key })),
    tool("move_node", "Moves a node under a new parent (or within its parent). index is its FINAL position among that parent's children.", { nodeId, newParentId: nodeId, index: z.number().int() }, ({ nodeId: id, newParentId, index }) =>
      apply({ type: "move_node", nodeId: id, newParentId, index }, { nodeId: id })),
    tool("remove_node", "Removes a node and everything inside it. The root cannot be removed.", { nodeId }, ({ nodeId: id }) => apply({ type: "remove_node", nodeId: id }, { removed: id })),
  ];
}
