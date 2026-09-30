import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Doc, DocNode, Manifest, Op, Presence, SequencedOp } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { ROOT_ID } from "@noon/doc-model";
import { colourOf } from "./colour.ts";
import { aiAnchors, anchorFor, initialsOf, isIdle, nameOf, summaryOf, tagOf, trackCursors, type Tracked } from "./cursors.ts";
import { AiPanel } from "./AiPanel.tsx";
import { ConflictBanner } from "./ConflictBanner.tsx";
import { Inspector, type Hint } from "./Inspector.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import type { Row } from "./layer-moves.ts";
import { addOpAt, type Slot } from "./library-adds.ts";
import { LibraryPanel, type Carry } from "./LibraryPanel.tsx";
import { PreviewSplit } from "./Preview.tsx";
import { sentenceFor } from "./reasons.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import { Page, Panel, Shell, TopBar } from "./Shell.tsx";
import { ShipPanel } from "./ShipPanel.tsx";
import { ShortcutSheet } from "./ShortcutSheet.tsx";
import { actionFor, typingIn } from "./shortcuts.ts";
import { Surface, type CursorMark, type Reveal } from "./Surface.tsx";
import { usePeer } from "./usePeer.ts";

type Component = Manifest["components"][number];
const componentOf = (name: string): Component | undefined => manifest.components.find((c) => c.name === name);

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
  // The AI's cursor (E10.6): per AI actor, the node its last op touched, from the ops the room orders. The
  // same map comes back for anyone else's op, so React sees no change and renders nothing for it.
  const [anchors, setAnchors] = useState<ReadonlyMap<string, string>>(new Map());
  const { peer, role, refusals, refuse, dismiss } = usePeer(documentId, (message: SequencedOp) => { setAnchors((current) => aiAnchors(current, message)); });
  const [wanted, setSelected] = useState(ROOT_ID);
  // An avatar was pressed: the canvas brings that person's selection to the middle (a new nonce each press).
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // The others' cursors with the time each last moved, so a still one fades (E10.6). A ref, renewed on each
  // render from what the peer says now: the moved-at times are the only thing remembered between renders.
  const tracked = useRef<Map<string, Tracked>>(new Map());
  const now = Date.now();
  tracked.current = trackCursors(tracked.current, peer?.others ?? [], now);
  // A cursor fades by the clock, not by an event: while any is shown, a tick a second re-reads the clock.
  const [, setTick] = useState(0);
  const anyCursor = tracked.current.size > 0;
  useEffect(() => {
    if (!anyCursor) return;
    const timer = setInterval(() => { setTick((n) => n + 1); }, 1000);
    return () => { clearInterval(timer); };
  }, [anyCursor]);
  // The AI panel is open until the person closes it (the top bar's AI button); not remembered, a session's choice.
  const [aiOpen, setAiOpen] = useState(true);
  // The running page beside the canvas (E10.7): closed until asked (it holds a container), by the bar's button or P.
  const [previewOpen, setPreviewOpen] = useState(false);
  // The `?` sheet of shortcuts (E10.7).
  const [sheetOpen, setSheetOpen] = useState(false);
  // The Share dialog (E10.8), an owner's: who this document is shared with, and with whom to share it.
  const [shareOpen, setShareOpen] = useState(false);
  // The global shortcuts (shortcuts.ts, scope "global"): anywhere in the editor, unless the person is typing
  // or a modal is up. A widget's own handler runs first and, finding no action of its own, lets the key bubble here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (sheetOpen || shareOpen || (event.target instanceof HTMLElement && typingIn(event.target))) return;
      const action = actionFor("global", event);
      if (action === "help") setSheetOpen(true);
      else if (action === "preview") setPreviewOpen((open) => !open);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [sheetOpen, shareOpen]);
  // A gap or padding control is hovered or focused in the inspector: the canvas shades that space (E10.4).
  const [hint, setHint] = useState<Hint | null>(null);
  // A component is carried from the library over the tree or the canvas (E10.5): whichever it is over shows where it would land.
  const [carry, setCarry] = useState<Carry | null>(null);
  // A ref, not state: the pointer moves sixty times a second and nothing on OUR screen depends on it.
  const cursor = useRef<Presence["cursor"]>(null);
  // Where the keyboard was when the replica refused an edit: Dismiss unmounts itself, so focus goes back there, not to <body>.
  const refusedFrom = useRef<HTMLElement | null>(null);
  const selection = peer && wanted !== ROOT_ID && peer.doc.nodes[wanted] ? wanted : null;
  useEffect(() => { peer?.setPresence({ cursor: cursor.current, selection }); }, [peer, selection]);
  // An add of this person's was refused (by the replica at once, or by the room later): the node it selected is
  // gone, and the selection goes back to the page instead of saying someone else removed it.
  useEffect(() => { if (refusals.some((each) => each.op?.type === "add_node" && each.op.nodeId === wanted)) setSelected(ROOT_ID); }, [refusals, wanted]);
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
  const isContainer = (id: string): boolean => { const each = doc.nodes[id]; return each !== undefined && holdsChildren(each); };
  const containers = [...labels].flatMap(([id, label]) => { const each = doc.nodes[id]; return each && holdsChildren(each) ? [{ id, label }] : []; });

  /**
   * Every edit goes through here: the replica's verdict comes back at once, the room's later (onRejected).
   * A new edit of a prop supersedes the refusal its last edit met: the inspector shows one complaint per
   * prop, the latest, and a fixed value clears it.
   */
  const submit = (op: Op): boolean => {
    if (op.type === "set_prop") for (const each of refusals) if (each.op?.type === "set_prop" && each.op.nodeId === op.nodeId && each.op.key === op.key) dismiss(each.id);
    const result = peer.submit(op);
    if (!result.ok) { refusedFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; refuse(result.reason, op); }
    return result.ok;
  };
  // The selected node's refused prop edits, latest per prop, for the inspector to repeat beside the control.
  const propRefusals = new Map(refusals.flatMap((each) => (each.op?.type === "set_prop" && each.op.nodeId === node.id ? [[each.op.key, each.reason] as const] : [])));
  // The library's one add (E10.5): the id is minted HERE, random and never reused (SPEC §2.4); the slot is the
  // library's (into or after the selection, or where a drag let go). The new node is selected, if the replica took it.
  const addAt = (component: Component, slot: Slot): void => {
    const nodeId = crypto.randomUUID();
    if (submit(addOpAt(slot, component, nodeId))) setSelected(nodeId);
  };
  // The others on the sheet (E10.6): a person where their pointer is, in world coordinates; the AI on the node
  // its last op touched (the page until it has touched one). Someone whose pointer has left the canvas has no mark.
  const marks = peer.others.flatMap((p): CursorMark[] => {
    const colour = colourOf(p.peerId);
    if (p.actor.kind === "agent") return [{ peerId: p.peerId, kind: p.actor.kind, label: tagOf(p), colour, idle: false, at: { nodeId: anchorFor(anchors, p.actor.id, doc) } }];
    const seen = tracked.current.get(p.peerId);
    return seen ? [{ peerId: p.peerId, kind: p.actor.kind, label: tagOf(p), colour, idle: isIdle(seen, now), at: seen.at }] : [];
  });
  // An avatar in the bar jumps to that person's selection: ours becomes theirs, and the canvas centres on it.
  const jumpTo = (p: Presence): void => {
    if (p.selection === null || !doc.nodes[p.selection]) return;
    setSelected(p.selection);
    setReveal((last) => ({ nodeId: p.selection ?? ROOT_ID, nonce: (last?.nonce ?? 0) + 1 }));
  };

  // The shell (E10.1): the top bar says how the document is doing and who is here, and holds Ship, AI and, for an
  // owner, Share (E10.8: shown by the role the session came with; the api decides regardless); layers left with the
  // library under them (E10.3, E10.5), the canvas in the centre, the inspector right with the AI panel under it.
  return (
    <Shell
      topBar={
        <TopBar>
          <h1 className="visually-hidden">Document</h1>
          <p className="doc-status">
            <span role="status" data-read-only={readOnly}>{readOnly ? "read-only" : peer.status}</span> · <span>{peer.pendingCount === 0 ? "saved" : `${readOnly ? "waiting to save" : "saving"} ${String(peer.pendingCount)}…`}</span>
          </p>
          {/* Who is here, for everyone: an avatar per connection that jumps to their selection (disabled while they have none), and
              one sentence a screen reader hears when the list changes. The cursors on the sheet are decoration; this is the record. */}
          <ul aria-label="Also here" className="also-here">
            {peer.others.map((p) => {
              const name = nameOf(p);
              const on = p.selection !== null && doc.nodes[p.selection] ? labels.get(p.selection) : undefined;
              return (
                <li key={p.peerId} style={{ "--peer-colour": colourOf(p.peerId) } as CSSProperties}>
                  <button type="button" className="avatar-button" disabled={on === undefined} onClick={() => { jumpTo(p); }}>
                    <span className="avatar" aria-hidden="true">{initialsOf(tagOf(p))}</span>
                    {name}
                    <span className="visually-hidden">{on === undefined ? ", nothing selected" : `, go to their selection, ${on}`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p aria-live="polite" className="visually-hidden">{summaryOf(peer.others)}</p>
          <div className="top-bar-actions">
            <ShipPanel documentId={documentId} />
            <button type="button" aria-pressed={previewOpen} aria-keyshortcuts="p" onClick={() => { setPreviewOpen((open) => !open); }}>Preview</button>
            <button type="button" aria-pressed={aiOpen} aria-controls="ai-panel" onClick={() => { setAiOpen((open) => !open); }}>AI</button>
            {role === "owner" && <button type="button" className="primary" aria-haspopup="dialog" onClick={() => { setShareOpen(true); }}>Share</button>}
            <button type="button" aria-label="Keyboard shortcuts (?)" aria-haspopup="dialog" aria-keyshortcuts="?" onClick={() => { setSheetOpen(true); }}>?</button>
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
              {sentenceFor(refusal.reason)} <button type="button" onClick={() => { dismiss(refusal.id); if (refusedFrom.current?.isConnected) refusedFrom.current.focus(); }}>Dismiss</button>
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
            <LayersPanel doc={doc} rows={layers} selected={node.id} isContainer={isContainer} onSelect={setSelected} submit={submit} insertion={carry?.kind === "tree" ? { targetId: carry.targetId, placement: carry.placement, allowed: carry.slot !== null } : null} />
          </Panel>
          {/* The library (E10.5): under the layers, not a tab beside them: a drag from a tile onto a ROW needs both on the screen at once. */}
          <Panel title="Library">
            <LibraryPanel doc={doc} selected={node.id} labels={labels} isContainer={isContainer} disabled={readOnly} onCarry={setCarry} onAdd={addAt} />
          </Panel>
        </>
      }
      centre={
        <>
          {/* The running page beside the canvas, in a device frame (E10.7), while Preview is on. */}
          <PreviewSplit open={previewOpen} documentId={documentId}>
            <Surface doc={doc} labels={labels} selected={node.id} selectedBy={selectedBy} hint={hint?.nodeId === node.id ? hint : null} isContainer={isContainer} insertion={carry?.kind === "canvas" ? carry.slot : null} onSelect={setSelected} onPoint={point} cursors={marks} reveal={reveal} />
          </PreviewSplit>
          <ShortcutSheet open={sheetOpen} onClose={() => { setSheetOpen(false); }} />
          {role === "owner" && <ShareDialog documentId={documentId} open={shareOpen} onClose={() => { setShareOpen(false); }} />}
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
