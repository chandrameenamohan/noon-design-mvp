import type { Doc, Presence, SequencedOp } from "@noon/contracts";
import { ROOT_ID } from "@noon/doc-model";
import type { Point } from "./viewport.ts";

/**
 * The pure part of live cursors (E10.6). Cursors travel in WORLD coordinates (viewport.ts: the frame's own
 * px at 100 %), so nothing here converts anything: it decides WHEN a cursor is idle, WHERE a peer that has
 * no pointer (the AI) sits, and WHAT a presence is called. Canvas.tsx binds it to the peer; Surface.tsx draws.
 */

/** How long a pointer may rest before its cursor fades: long enough to read the tag, short enough not to litter the sheet. */
export const IDLE_AFTER_MS = 5000;

/** A person's cursor as last heard, and when it last MOVED (a presence refresh repeats the same spot; that is not a move). */
export type Tracked = { at: Point; movedAt: number };

/** The others' cursors, keyed by connection. A peer without a pointer (left the canvas, or the AI) has no entry. */
export function trackCursors(previous: ReadonlyMap<string, Tracked>, others: readonly Presence[], now: number): Map<string, Tracked> {
  const next = new Map<string, Tracked>();
  for (const p of others) {
    if (!p.cursor) continue;
    const was = previous.get(p.peerId);
    next.set(p.peerId, was && was.at.x === p.cursor.x && was.at.y === p.cursor.y ? was : { at: { x: p.cursor.x, y: p.cursor.y }, movedAt: now });
  }
  return next;
}

export const isIdle = (tracked: Tracked, now: number): boolean => now - tracked.movedAt >= IDLE_AFTER_MS;

/**
 * The AI has no pointer: its cursor sits on the node its last accepted op touched, by the actor id the room
 * stamped on the op (two runs are two anchors). A person's or the git peer's op moves nothing, and the SAME
 * map comes back, so nothing renders for it. A removal leaves the anchor where it was: the removed node has
 * no box to sit on. ponytail: its parent would be the better seat, but the op does not carry it and the
 * listener hears the op after it is applied; the upgrade is a `parentId` on remove_node's broadcast.
 */
export function aiAnchors(previous: ReadonlyMap<string, string>, message: SequencedOp): ReadonlyMap<string, string> {
  if (message.actor.kind !== "agent" || message.op.type === "remove_node") return previous;
  return new Map(previous).set(message.actor.id, message.op.nodeId);
}

/** Where an AI's cursor sits now: its anchor while that node exists, else the page (an AI that has just arrived, or whose node went). */
export const anchorFor = (anchors: ReadonlyMap<string, string>, actorId: string, doc: Doc): string => {
  const at = anchors.get(actorId);
  return at !== undefined && doc.nodes[at] ? at : ROOT_ID;
};

/** The cursor's tag: short, since it rides the pointer. The AI is "AI"; a person is their name. */
export const tagOf = (p: Presence): string => (p.actor.kind === "agent" ? "AI" : p.name === "" ? p.actor.kind : p.name);
/** The bar's word for a presence: the AI says what it is, a person is their name (or their kind, if the session gave none). */
export const nameOf = (p: Presence): string => (p.actor.kind === "agent" ? "AI agent" : p.name === "" ? p.actor.kind : p.name);
/** Up to two initials for an avatar; an email address is one word, so one letter. */
export const initialsOf = (name: string): string => (name === "AI" ? name : name.split(/\s+/u).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join(""));
/** One sentence for a screen reader: who is here, said when the list changes; the cursors themselves are decoration. */
export const summaryOf = (others: readonly Presence[]): string => (others.length === 0 ? "" : `Also here: ${others.map(nameOf).join(", ")}.`);
