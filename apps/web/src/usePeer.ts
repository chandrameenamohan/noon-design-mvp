import { useEffect, useState, useSyncExternalStore } from "react";
import { manifest } from "@noon/design-system";
import { connectPeer, type Rejection } from "@noon/peer-client";
import type { sentenceFor } from "./reasons.ts";

type Reason = Parameters<typeof sentenceFor>[0];
/** An edit that did not happen, waiting for the user to read it. `id` only makes it dismissible. */
type Refusal = { id: string; reason: Reason };
import { openSession } from "./api.ts";

function openStore(documentId: string, onRejected: (rejection: Rejection) => void) {
  const listeners = new Set<() => void>();
  const tell = (): void => { for (const listener of listeners) listener(); };
  const peer = connectPeer({ manifest, session: () => openSession(documentId), onChange: tell, onStatus: tell, onRejected });
  return {
    peer,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // peer.doc is edited IN PLACE and never changes identity, so the snapshot is built from what does move.
    snapshot: () => `${String(peer.revision)}:${String(peer.pendingCount)}:${peer.status}`,
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
 */
export function usePeer(documentId: string) {
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [store, setStore] = useState<ReturnType<typeof openStore>>();
  const refuse = (reason: Reason): void => { setRefusals((before) => [...before, { id: crypto.randomUUID(), reason }]); };
  useEffect(() => {
    // `quiet` (someone else removed the node first) is not news: the canvas already shows it (F5).
    const opened = openStore(documentId, (rejection) => { if (!rejection.quiet) refuse(rejection.reason); });
    setStore(opened);
    return () => { opened.peer.close(); };
  }, [documentId]);
  useSyncExternalStore((store ?? NOTHING).subscribe, (store ?? NOTHING).snapshot);
  return { peer: store?.peer, refusals, refuse, dismiss: (id: string): void => { setRefusals((before) => before.filter((each) => each.id !== id)); } };
}
