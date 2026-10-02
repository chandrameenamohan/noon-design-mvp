import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { manifest } from "@noon/design-system";
import { connectPeer, type Rejection } from "@noon/peer-client";
import type { Op, Role, SequencedOp, SessionResponse } from "@noon/contracts";
import type { sentenceFor } from "./reasons.ts";

type Reason = Parameters<typeof sentenceFor>[0];
/** An edit that did not happen, waiting for the user to read it. `id` only makes it dismissible; `op` lets the inspector repeat it beside the control it was about (E10.4). */
export type Refusal = { id: string; reason: Reason; op?: Op };
import { openSession } from "./api.ts";

function openStore(documentId: string, onRejected: (rejection: Rejection) => void, onOp: (message: SequencedOp) => void, onSession: (session: SessionResponse) => void, onRole: (role: Role) => void) {
  const listeners = new Set<() => void>();
  const tell = (): void => { for (const listener of listeners) listener(); };
  // Every session minted passes here (a reconnect too), so the role the editor shows controls by is the api's latest word.
  const session = async (): Promise<SessionResponse | null> => {
    const minted = await openSession(documentId);
    if (minted) onSession(minted);
    return minted;
  };
  const peer = connectPeer({ manifest, session, onChange: tell, onStatus: tell, onRejected, onOp, onRole });
  return {
    peer,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // peer.doc is edited IN PLACE and never changes identity, so the snapshot is built from what does move.
    snapshot: () => `${String(peer.revision)}:${String(peer.pendingCount)}:${peer.status}:${String(peer.readOnly)}:${String(peer.presenceRevision)}`,
  };
}
const NOTHING = { subscribe: () => () => undefined, snapshot: () => "" };

/**
 * One peer for one document, for as long as the component is mounted.
 *
 * The peer lives OUTSIDE React and changes on its own: a WebSocket message is not a render.
 * useSyncExternalStore is React's door for that: "how to subscribe, how to read a snapshot". React
 * re-renders when the snapshot differs (Object.is) from the last one.
 *
 * It is opened in an EFFECT, never during render or in useMemo: opening a connection is a side
 * effect, and React may run a render twice and throw one away (StrictMode does so on purpose, in
 * development, to catch exactly this). An effect comes with a cleanup; a render does not.
 *
 * `onOp` (E10.6): every op the room orders, ours included, with its actor. Held in a ref, so the caller may
 * pass a new function each render without the peer being opened again.
 *
 * `role` (E10.8): the caller's role on the document as the api said when it minted the latest session, or as the room
 * said since when it changed while the session stayed open (noon-frc); undefined until either has, or when the api did not say. What the top bar shows controls by (Share is the owners'); never what decides.
 */
export function usePeer(documentId: string, onOp?: (message: SequencedOp) => void) {
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [store, setStore] = useState<ReturnType<typeof openStore>>();
  const [role, setRole] = useState<Role>();
  const refuse = (reason: Reason, op?: Op): void => { setRefusals((before) => [...before, { id: crypto.randomUUID(), reason, ...(op === undefined ? {} : { op }) }]); };
  const latestOnOp = useRef(onOp);
  latestOnOp.current = onOp;
  useEffect(() => {
    // `quiet` (someone else removed the node first) is not news: the canvas already shows it (F5).
    const opened = openStore(documentId, (rejection) => { if (!rejection.quiet) refuse(rejection.reason, rejection.op); }, (message) => latestOnOp.current?.(message), (session) => { setRole(session.role); }, setRole);
    setStore(opened);
    return () => { opened.peer.close(); };
  }, [documentId]);
  useSyncExternalStore((store ?? NOTHING).subscribe, (store ?? NOTHING).snapshot);
  return { peer: store?.peer, role, refusals, refuse, dismiss: (id: string): void => { setRefusals((before) => before.filter((each) => each.id !== id)); } };
}
