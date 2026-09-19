import { useState } from "react";
import type { Doc, DocNode, Manifest, Op } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { usePeer } from "./usePeer.ts";

type Component = Manifest["components"][number];
const componentOf = (name: string): Component | undefined => manifest.components.find((c) => c.name === name);

/** The props a new node must have: the manifest says which are required, and of what type. */
function requiredProps(component: Component): Extract<Op, { type: "add_node" }>["props"] {
  const props: Record<string, string | number | boolean> = {};
  for (const prop of component.props.filter((p) => p.required)) {
    props[prop.name] = prop.type.kind === "string" ? component.name : prop.type.kind === "number" ? 0 : prop.type.kind === "boolean" ? false : (prop.type.options[0] ?? "");
  }
  return props;
}

/**
 * One node as a wireframe: its name, its props, its children. NOT the real component: the real app
 * is rendered by the sandbox preview (epic 4). ponytail: plain recursion, every node re-rendered on
 * every change (the document is at most 64 deep and checkDoc'd on arrival); memo per node, keyed on
 * the node object (which keeps its identity while untouched), is the upgrade when a big document lags.
 */
function NodeView({ doc, node, selected, onSelect }: { doc: Doc; node: DocNode; selected: string; onSelect: (id: string) => void }) {
  const isRoot = node.parentId === null;
  const direction = node.props["direction"] === "row" ? "row" : "column";
  return (
    <div data-node-id={node.id} data-component={node.component} className={node.id === selected ? "node selected" : "node"}>
      <button type="button" className="node-name" aria-pressed={node.id === selected} onClick={() => { onSelect(node.id); }}>
        <span className="visually-hidden">Select </span>
        {isRoot ? "Page" : node.component}
      </button>
      <span className="node-props">{Object.entries(node.props).map(([key, value]) => `${key}=${String(value)}`).join(" ")}</span>
      <div data-children style={{ flexDirection: direction }}>
        {node.children.map((id) => {
          const child = doc.nodes[id];
          return child ? <NodeView key={id} doc={doc} node={child} selected={selected} onSelect={onSelect} /> : null;
        })}
      </div>
    </div>
  );
}

export function Canvas({ documentId }: { documentId: string }) {
  const { peer, rejections } = usePeer(documentId);
  const [selected, setSelected] = useState(ROOT_ID);
  if (!peer) return <main><h1>Noon MVP</h1><p><span role="status">connecting</span></p></main>;
  const root = peer.doc.nodes[peer.doc.rootId];

  // New nodes go INTO the selection when it can hold children, otherwise onto the page.
  const target = peer.doc.nodes[selected];
  const parent = target && (target.parentId === null || componentOf(target.component)?.acceptsChildren) ? target : root;
  const add = (component: Component): void => {
    if (!parent) return;
    // The id is minted HERE, random and never reused (SPEC §2.4). `index` is the node's final position: the end.
    peer.submit({ type: "add_node", nodeId: crypto.randomUUID(), parentId: parent.id, index: parent.children.length, component: component.name, props: requiredProps(component) });
  };

  return (
    <main>
      <h1>Noon MVP</h1>
      <p>
        <span role="status">{peer.status}</span> · <span>{peer.pendingCount === 0 ? "saved" : `saving ${String(peer.pendingCount)}…`}</span>
      </p>
      <div role="toolbar" aria-label="Add a component">
        {manifest.components.map((component) => (
          <button key={component.name} type="button" disabled={peer.status !== "live" && peer.status !== "offline"} onClick={() => { add(component); }}>
            Add {component.name}
          </button>
        ))}
      </div>
      {rejections.length > 0 && (
        <ul aria-label="Edits that were refused">
          {rejections.map((r) => <li key={r.opId}>{r.reason}</li>)}
        </ul>
      )}
      <section aria-label="Canvas" className="canvas">
        {root ? <NodeView doc={peer.doc} node={root} selected={selected} onSelect={setSelected} /> : null}
      </section>
    </main>
  );
}
