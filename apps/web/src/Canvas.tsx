import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Doc, DocNode, Manifest, Op, Presence } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { colourOf } from "./colour.ts";
import { AiPanel } from "./AiPanel.tsx";
import { ConflictBanner } from "./ConflictBanner.tsx";
import { Inspector, type Hint } from "./Inspector.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import type { Row } from "./layer-moves.ts";
import { Preview } from "./Preview.tsx";
import { sentenceFor } from "./reasons.ts";
import { Page, Panel, Shell, TopBar } from "./Shell.tsx";
import { ShipPanel } from "./ShipPanel.tsx";
import { Surface } from "./Surface.tsx";
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
 * Every node in reading order, with a name a person (and a screen reader) can tell apart, "Stack 2"
 * being the second Stack in that order, and how deep it sits. Iterative: a tree walk that recurses is
 * one deep document away from a crash.
 */
function layersOf(doc: Doc): Row[] {
  const rows: Row[] = [{ id: doc.rootId, label: "Page", depth: 0 }];
  const seen = new Set([doc.rootId]);
  const counts = new Map<string, number>();
  const stack = [...(doc.nodes[doc.rootId]?.children ?? [])].reverse().map((id) => ({ id, depth: 1 }));
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const node = doc.nodes[next.id];
    if (!node || seen.has(next.id)) continue;
    seen.add(next.id);
    const nth = (counts.get(node.component) ?? 0) + 1;
    counts.set(node.component, nth);
    rows.push({ id: next.id, label: `${node.component} ${String(nth)}`, depth: next.depth });
    stack.push(...[...node.children].reverse().map((id) => ({ id, depth: next.depth + 1 })));
  }
  return rows;
}

export function Canvas({ documentId }: { documentId: string }) {
  const { peer, refusals, refuse, dismiss } = usePeer(documentId);
  const [wanted, setSelected] = useState(ROOT_ID);
  // The AI panel is open until the person closes it (the top bar's AI button); not remembered, a session's choice.
  const [aiOpen, setAiOpen] = useState(true);
  // A gap or padding control is hovered or focused in the inspector: the canvas shades that space (E10.4).
  const [hint, setHint] = useState<Hint | null>(null);
  // A ref, not state: the pointer moves sixty times a second and nothing on OUR screen depends on it.
  const cursor = useRef<Presence["cursor"]>(null);
  const selection = peer && wanted !== ROOT_ID && peer.doc.nodes[wanted] ? wanted : null;
  useEffect(() => { peer?.setPresence({ cursor: cursor.current, selection }); }, [peer, selection]);
  if (!peer) return <Page><h1>Document</h1><p><span role="status">connecting</span></p></Page>;
  if (peer.status === "closed") {
    // The peer ended for good (peer.closedBecause: no session, a fatal close code, a corrupt document).
    return <Page><h1>Document</h1><p role="alert" className="refusal">This document cannot be opened ({peer.closedBecause ?? "closed"}). <a href="/">Back to start</a></p></Page>;
  }
  const doc = peer.doc;
  const readOnly = peer.status === "live" && peer.readOnly;
  const root = doc.nodes[doc.rootId];
  if (!root) return null;
  // DERIVED, not stored: if someone else removes the selected node, the selection is simply the page again.
  const node = doc.nodes[wanted] ?? root;
  const layers = layersOf(doc);
  const labels = new Map(layers.map((row) => [row.id, row.label]));
  const selectedBy = Map.groupBy(peer.others.filter((p) => p.selection !== null), (p) => p.selection ?? "");
  const point = (next: Presence["cursor"]): void => { cursor.current = next; peer.setPresence({ cursor: next, selection }); };
  const holdsChildren = (each: DocNode): boolean => each.parentId === null || componentOf(each.component)?.acceptsChildren === true;
  const containers = [...labels].flatMap(([id, label]) => { const each = doc.nodes[id]; return each && holdsChildren(each) ? [{ id, label }] : []; });

  /**
   * Every edit goes through here: the replica's verdict comes back at once, the room's later (onRejected).
   * A new edit of a prop supersedes the refusal its last edit met: the inspector shows one complaint per
   * prop, the latest, and a fixed value clears it.
   */
  const submit = (op: Op): void => {
    if (op.type === "set_prop") for (const each of refusals) if (each.op?.type === "set_prop" && each.op.nodeId === op.nodeId && each.op.key === op.key) dismiss(each.id);
    const result = peer.submit(op);
    if (!result.ok) refuse(result.reason, op);
  };
  // The selected node's refused prop edits, latest per prop, for the inspector to repeat beside the control.
  const propRefusals = new Map(refusals.flatMap((each) => (each.op?.type === "set_prop" && each.op.nodeId === node.id ? [[each.op.key, each.reason] as const] : [])));
  // New nodes go INTO the selection when it can hold children, otherwise onto the page.
  const parent = holdsChildren(node) ? node : root;
  // The id is minted HERE, random and never reused (SPEC §2.4). `index` is the node's final position: the end.
  const add = (component: Component): void => { submit({ type: "add_node", nodeId: crypto.randomUUID(), parentId: parent.id, index: parent.children.length, component: component.name, props: requiredProps(component) }); };

  // The shell (E10.1): the top bar says how the document is doing and who is here, and holds Ship and AI;
  // layers left (E10.3 fills it; the component toolbar sits there until E10.5's library replaces it), the
  // canvas in the centre, the inspector right with the AI panel under it. Share arrives with E10.8.
  return (
    <Shell
      topBar={
        <TopBar>
          <h1 className="visually-hidden">Document</h1>
          <p className="doc-status">
            <span role="status" data-read-only={readOnly}>{readOnly ? "read-only" : peer.status}</span> · <span>{peer.pendingCount === 0 ? "saved" : `${readOnly ? "waiting to save" : "saving"} ${String(peer.pendingCount)}…`}</span>
          </p>
          <ul aria-label="Also here" className="also-here">
            {peer.others.map((p) => <li key={p.peerId} style={{ "--peer-colour": colourOf(p.peerId) } as CSSProperties}>{p.name === "" ? p.actor.kind : p.name}</li>)}
          </ul>
          <div className="top-bar-actions">
            <ShipPanel documentId={documentId} />
            <button type="button" aria-pressed={aiOpen} aria-controls="ai-panel" onClick={() => { setAiOpen((open) => !open); }}>AI</button>
          </div>
        </TopBar>
      }
      notices={
        <>
          {/* E6.1b: the room's storage is down. An alert, so a screen reader says it the moment it happens. */}
          {readOnly && <p role="alert" className="read-only">Read-only: the server cannot save edits right now. Edits you already made are kept and will be saved when it can; new edits are paused.</p>}
          <ConflictBanner documentId={documentId} />
          {refusals.map((refusal) => (
            <p key={refusal.id} role="alert" className="refusal">
              {sentenceFor(refusal.reason)} <button type="button" onClick={() => { dismiss(refusal.id); }}>Dismiss</button>
            </p>
          ))}
          {/* Said, not shown: someone who cannot see the canvas still learns that their selection is gone. */}
          <p aria-live="polite" className="visually-hidden">{wanted !== ROOT_ID && !doc.nodes[wanted] ? "The element you had selected was removed by someone else." : ""}</p>
        </>
      }
      left={
        <>
          {/* The document as a tree (E10.3): the same selection as the canvas, and drag or Alt+arrows move a node as ONE move_node through submit. */}
          <Panel title="Layers">
            <LayersPanel doc={doc} rows={layers} selected={node.id} isContainer={(id) => { const each = doc.nodes[id]; return each !== undefined && holdsChildren(each); }} onSelect={setSelected} submit={submit} />
          </Panel>
          <Panel title="Library">
            <div role="toolbar" aria-label="Add a component">
              {manifest.components.map((component) => <button key={component.name} type="button" disabled={readOnly} onClick={() => { add(component); }}>Add {component.name}</button>)}
            </div>
          </Panel>
        </>
      }
      centre={
        <>
          <Surface doc={doc} labels={labels} selected={node.id} selectedBy={selectedBy} hint={hint?.nodeId === node.id ? hint : null} onSelect={setSelected} onPoint={point}>
            {peer.others.map((p) => p.cursor && (
              <span key={p.peerId} data-presence-cursor aria-hidden="true" className="presence-cursor" style={{ left: `${String(p.cursor.x * 100)}%`, top: `${String(p.cursor.y * 100)}%`, background: colourOf(p.peerId) }}>{p.name}</span>
            ))}
          </Surface>
          <Preview documentId={documentId} />
        </>
      }
      right={
        <>
          <Inspector key={node.id} doc={doc} node={node} label={labels.get(node.id) ?? node.component} component={componentOf(node.component)} containers={containers} refusals={propRefusals} submit={submit} onHint={setHint} />
          <AiPanel documentId={documentId} hidden={!aiOpen} />
        </>
      }
    />
  );
}
