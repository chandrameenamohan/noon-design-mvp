import { useEffect, useRef, useState } from "react";
import type { Doc, DocNode, Manifest, Op, Presence } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { colourOf } from "./colour.ts";
import { AiPanel } from "./AiPanel.tsx";
import { ConflictBanner } from "./ConflictBanner.tsx";
import { Inspector } from "./Inspector.tsx";
import { Preview } from "./Preview.tsx";
import { sentenceFor } from "./reasons.ts";
import { ShipPanel } from "./ShipPanel.tsx";
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
 * A name for every node that a person (and a screen reader) can tell apart: "Stack 2" is the second
 * Stack in reading order. Iterative: a tree walk that recurses is one deep document away from a crash.
 */
function labelsOf(doc: Doc): Map<string, string> {
  const labels = new Map<string, string>([[doc.rootId, "Page"]]);
  const counts = new Map<string, number>();
  const stack = [...(doc.nodes[doc.rootId]?.children ?? [])].reverse();
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    const node = doc.nodes[id];
    if (!node || labels.has(id)) continue;
    const nth = (counts.get(node.component) ?? 0) + 1;
    counts.set(node.component, nth);
    labels.set(id, `${node.component} ${String(nth)}`);
    stack.push(...[...node.children].reverse());
  }
  return labels;
}

/**
 * One node as a wireframe: its name, its props, its children. NOT the real component: the real app
 * is rendered by the sandbox preview (epic 4). ponytail: every node re-rendered on every change (the
 * document is at most 64 deep and checkDoc'd on arrival); memo per node, keyed on the node object
 * (which keeps its identity while untouched), is the upgrade when a big document lags.
 */
function NodeView({ doc, node, labels, selected, selectedBy, onSelect }: { doc: Doc; node: DocNode; labels: Map<string, string>; selected: string; selectedBy: Map<string, Presence[]>; onSelect: (id: string) => void }) {
  const direction = node.props["direction"] === "row" ? "row" : "column";
  const others = selectedBy.get(node.id) ?? [];
  return (
    <div data-node-id={node.id} data-component={node.component} className={node.id === selected ? "node selected" : "node"} {...(others[0] ? { "data-selected-by": others.map((p) => p.name).join(", "), style: { outline: `2px solid ${colourOf(others[0].peerId)}` } } : {})}>
      <button type="button" className="node-name" aria-pressed={node.id === selected} onClick={() => { onSelect(node.id); }}>
        <span className="visually-hidden">Select </span>
        {labels.get(node.id) ?? node.component}
      </button>
      {others.map((p) => <span key={p.peerId} className="selected-by" style={{ color: colourOf(p.peerId) }}>{p.name}</span>)}
      <span className="node-props">{Object.entries(node.props).map(([key, value]) => `${key}=${String(value)}`).join(" ")}</span>
      <div data-children style={{ flexDirection: direction }}>
        {node.children.map((id) => {
          const child = doc.nodes[id];
          return child ? <NodeView key={id} doc={doc} node={child} labels={labels} selected={selected} selectedBy={selectedBy} onSelect={onSelect} /> : null;
        })}
      </div>
    </div>
  );
}

export function Canvas({ documentId }: { documentId: string }) {
  const { peer, refusals, refuse, dismiss } = usePeer(documentId);
  const [wanted, setSelected] = useState(ROOT_ID);
  // A ref, not state: the pointer moves sixty times a second and nothing on OUR screen depends on it.
  const cursor = useRef<Presence["cursor"]>(null);
  const selection = peer && wanted !== ROOT_ID && peer.doc.nodes[wanted] ? wanted : null;
  useEffect(() => { peer?.setPresence({ cursor: cursor.current, selection }); }, [peer, selection]);
  if (!peer) return <main><h1>Noon MVP</h1><p><span role="status">connecting</span></p></main>;
  if (peer.status === "closed") {
    // The peer ended for good (peer.closedBecause: no session, a fatal close code, a corrupt document).
    return <main><h1>Noon MVP</h1><p role="alert">This document cannot be opened ({peer.closedBecause ?? "closed"}). <a href="/">Back to start</a></p></main>;
  }
  const doc = peer.doc;
  const readOnly = peer.status === "live" && peer.readOnly;
  const root = doc.nodes[doc.rootId];
  if (!root) return null;
  // DERIVED, not stored: if someone else removes the selected node, the selection is simply the page again.
  const node = doc.nodes[wanted] ?? root;
  const labels = labelsOf(doc);
  const selectedBy = Map.groupBy(peer.others.filter((p) => p.selection !== null), (p) => p.selection ?? "");
  const point = (next: Presence["cursor"]): void => { cursor.current = next; peer.setPresence({ cursor: next, selection }); };
  const holdsChildren = (each: DocNode): boolean => each.parentId === null || componentOf(each.component)?.acceptsChildren === true;
  const containers = [...labels].flatMap(([id, label]) => { const each = doc.nodes[id]; return each && holdsChildren(each) ? [{ id, label }] : []; });

  /** Every edit goes through here: the replica's verdict comes back at once, the room's later (onRejected). */
  const submit = (op: Op): void => {
    const result = peer.submit(op);
    if (!result.ok) refuse(result.reason);
  };
  // New nodes go INTO the selection when it can hold children, otherwise onto the page.
  const parent = holdsChildren(node) ? node : root;
  // The id is minted HERE, random and never reused (SPEC §2.4). `index` is the node's final position: the end.
  const add = (component: Component): void => { submit({ type: "add_node", nodeId: crypto.randomUUID(), parentId: parent.id, index: parent.children.length, component: component.name, props: requiredProps(component) }); };

  return (
    <main>
      <h1>Noon MVP</h1>
      <p>
        <span role="status" data-read-only={readOnly}>{readOnly ? "read-only" : peer.status}</span> · <span>{peer.pendingCount === 0 ? "saved" : `${readOnly ? "waiting to save" : "saving"} ${String(peer.pendingCount)}…`}</span>
      </p>
      {/* E6.1b: the room's storage is down. An alert, so a screen reader says it the moment it happens. */}
      {readOnly && <p role="alert" className="read-only">Read-only: the server cannot save edits right now. Edits you already made are kept and will be saved when it can; new edits are paused.</p>}
      <div role="toolbar" aria-label="Add a component">
        {manifest.components.map((component) => <button key={component.name} type="button" disabled={readOnly} onClick={() => { add(component); }}>Add {component.name}</button>)}
      </div>
      <ConflictBanner documentId={documentId} />
      <ShipPanel documentId={documentId} />
      <AiPanel documentId={documentId} />
      {refusals.map((refusal) => (
        <p key={refusal.id} role="alert" className="refusal">
          {sentenceFor(refusal.reason)} <button type="button" onClick={() => { dismiss(refusal.id); }}>Dismiss</button>
        </p>
      ))}
      <ul aria-label="Also here" className="also-here">
        {peer.others.map((p) => <li key={p.peerId} style={{ color: colourOf(p.peerId) }}>{p.name === "" ? p.actor.kind : p.name}</li>)}
      </ul>
      {/* Said, not shown: someone who cannot see the canvas still learns that their selection is gone. */}
      <p aria-live="polite" className="visually-hidden">{wanted !== ROOT_ID && !doc.nodes[wanted] ? "The element you had selected was removed by someone else." : ""}</p>
      <div className="workspace">
        <section
          aria-label="Canvas"
          className="canvas"
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            // A FRACTION of the canvas, not pixels: the other window is a different size.
            point({ x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) });
          }}
          onPointerLeave={() => { point(null); }}
        >
          <NodeView doc={doc} node={root} labels={labels} selected={node.id} selectedBy={selectedBy} onSelect={setSelected} />
          {peer.others.map((p) => p.cursor && (
            <span key={p.peerId} data-presence-cursor aria-hidden="true" className="presence-cursor" style={{ left: `${String(p.cursor.x * 100)}%`, top: `${String(p.cursor.y * 100)}%`, background: colourOf(p.peerId) }}>{p.name}</span>
          ))}
        </section>
        <Inspector key={node.id} doc={doc} node={node} label={labels.get(node.id) ?? node.component} component={componentOf(node.component)} containers={containers} submit={submit} />
      </div>
      <Preview documentId={documentId} />
    </main>
  );
}
