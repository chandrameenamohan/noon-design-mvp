import { z } from "zod";

// The pure half of room ownership (F20): what a lease value says, when a holder must stop believing it
// holds one, and which sync node a peer is sent to. No I/O here; index.ts talks to Redis.

/**
 * Who owns a document's room: a sync node, and the fencing token its acquisition was issued. The token
 * rises with every acquisition of that document (INCR), so two holders are never confused, even when one
 * node takes the same room twice, and a later owner always carries the larger number (the fence of E7.3).
 */
export type Holder = { token: number; nodeId: string };

/** A node id is a URL path segment and a compose service name: lowercase, digits, dashes. */
export const NodeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "a sync node id is 1-32 of a-z, 0-9 and -, starting with a letter or digit");

export const formatHolder = ({ token, nodeId }: Holder): string => `${String(token)}:${nodeId}`;

/** A value read back from Redis. Anything else there is not ours to trust: undefined. */
export function parseHolder(value: string): Holder | undefined {
  const match = /^([1-9]\d{0,15}):(.+)$/.exec(value);
  if (!match?.[1] || !match[2] || !NodeId.safeParse(match[2]).success) return undefined;
  return { token: Number(match[1]), nodeId: match[2] };
}

export type LeaseKeeper = {
  /** False from the moment this process can no longer be sure it holds the lease. Never true again. */
  readonly held: boolean;
  /** Renew once (call every ttl/3). Also the moment an unrenewable lease is declared lost. */
  tick(): Promise<void>;
};

/**
 * Keeps a lease that was just acquired, and decides when to stop trusting it.
 *
 * Only OUR monotonic clock is used, never a wall clock, never a time from another machine: Redis starts a
 * PX countdown when it RECEIVES the command, which is after we sent it, so "sent + ttl" (on our own clock)
 * is never later than Redis's expiry. The margin covers the two clocks running at slightly different rates.
 * `renew` answers false when the lease is someone else's now (lost at once) and throws when Redis cannot be
 * asked (still ours until the deadline passes). `acquiredAt` must be read BEFORE the acquire was sent.
 *
 * This is not safety: a process frozen past the deadline believes `held` until it runs again. The journal's
 * fence (E7.3) is what refuses that zombie's writes; this only makes a live node give its peers up promptly.
 */
export function keepLease({ renew, ttlMs, now, acquiredAt, onLost }: { renew: () => Promise<boolean>; ttlMs: number; now: () => number; acquiredAt: number; onLost: () => void }): LeaseKeeper {
  const trusted = (sentAt: number): number => sentAt + ttlMs * 0.9;
  let validUntil = trusted(acquiredAt);
  let lost = false;
  let renewing = false;
  const lose = (): void => {
    if (lost) return;
    lost = true;
    onLost();
  };
  const expired = (): boolean => {
    if (!lost && now() >= validUntil) lose();
    return lost;
  };
  return {
    get held() { return !expired(); },
    async tick() {
      // A renewal still in flight (a hung Redis, bounded by the client's command timeout) is not waited
      // for twice, but the deadline is still checked: a hang must not keep a room alive.
      if (expired() || renewing) return;
      renewing = true;
      const sentAt = now();
      try {
        if (await renew()) validUntil = trusted(sentAt);
        else lose();
      } catch {
        // Redis did not answer: keep trying on the next tick while the deadline allows.
      } finally {
        renewing = false;
      }
      expired();
    },
  };
}

/**
 * The sync nodes a peer can be sent to, from one variable: a single `ws(s)://` URL (one node, no lease
 * lookup: the single-node setup and the tests), or `id=url,id=url` (the routing table of epic 7).
 */
export type SyncNodes = { kind: "one"; url: string } | { kind: "many"; nodes: ReadonlyMap<string, string> };

// A query or fragment would swallow the "/documents/<id>" that gets appended to the address.
const wsBase = (value: string): string | undefined => {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return ["ws:", "wss:"].includes(url.protocol) && url.search === "" && url.hash === "" && !value.includes("?") && !value.includes("#") ? value.replace(/\/+$/, "") : undefined;
};

export function parseSyncNodes(value: string): SyncNodes | undefined {
  if (!value.includes("=")) {
    const url = wsBase(value);
    return url === undefined ? undefined : { kind: "one", url };
  }
  const nodes = new Map<string, string>();
  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const at = entry.indexOf("=");
    const id = entry.slice(0, at).trim();
    const url = wsBase(entry.slice(at + 1).trim());
    if (!NodeId.safeParse(id).success || url === undefined || nodes.has(id)) return undefined;
    nodes.set(id, url);
  }
  return nodes.size > 0 ? { kind: "many", nodes } : undefined;
}

/** A zod field for an env variable holding sync nodes, with the variable's name in its error. */
export const syncNodesField = (name: string) =>
  z.string({ error: `${name} is required` }).transform((value, ctx) => {
    const nodes = parseSyncNodes(value);
    if (!nodes) {
      ctx.addIssue({ code: "custom", message: `${name} must be a ws:// or wss:// URL without a query or fragment, or a list id=url,id=url of them` });
      return z.NEVER;
    }
    return nodes;
  });

/**
 * Where a peer of `documentId` dials: the room's owner if it has one and is alive, otherwise any live node
 * (`pick`), whose first peer then tries to take the lease. Two nodes racing for a free room is fine: exactly one
 * wins, and the other closes its peers with 4409, sending them back here, where the owner is now known.
 * An owner that stopped beating (killed, E7.2) still holds its lease until it expires: its peers are sent to a
 * live node, which waits that lease out and takes the room (takeLease below), instead of dialling a dead one.
 * `owner` or `alive` throwing means Redis cannot be asked: the caller answers "try again".
 * Liveness is only a hint for routing: a node wrongly thought dead costs a peer one 4409, never a second room.
 */
export function syncRouter({ nodes, owner, alive, pick = randomNode }: { nodes: SyncNodes; owner: (documentId: string) => Promise<Holder | undefined>; alive: (nodeIds: readonly string[]) => Promise<ReadonlySet<string>>; pick?: (ids: readonly string[]) => string }): (documentId: string) => Promise<string> {
  return async (documentId) => {
    if (nodes.kind === "one") return `${nodes.url}/documents/${documentId}`;
    const ids = [...nodes.nodes.keys()];
    const [holder, beating] = await Promise.all([owner(documentId), alive(ids)]);
    // Owned by a node this table does not name: sending the peer anywhere else would loop on 4409 for ever.
    if (holder && !nodes.nodes.has(holder.nodeId)) throw new Error(`the room is owned by sync node "${holder.nodeId}", which is not in the routing table`);
    const live = ids.filter((id) => beating.has(id));
    // Nobody beating at all (Redis just restarted, or heartbeats cannot be written): route as if all were alive.
    const id = holder && (beating.has(holder.nodeId) || live.length === 0) ? holder.nodeId : pick(live.length > 0 ? live : ids);
    return `${nodes.nodes.get(id) ?? ""}/documents/${documentId}`;
  };
}

const randomNode = (ids: readonly string[]): string => ids[Math.floor(Math.random() * ids.length)] ?? "";

/**
 * A node's first peer of a room has arrived: take the lease. Held by a live node: refused at once (its peers
 * go to the owner). Held by a node that stopped beating, or under OUR id by a run of this node that is gone
 * (killed and restarted): that lease can only expire, so wait for it, polling, for at most one ttl, then take
 * the room (F21). Never stolen early: until it expires, the dead holder's lease is the only truth there is.
 * `acquiredAt` is read BEFORE the winning acquire was sent (keepLease's deadline counts from it).
 * ponytail: polls every ttl/10 rather than waiting for the key's exact expiry; ceiling: the takeover lands up to
 * ttl/10 after the lease expired. Upgrade: return the PTTL from the acquire script and sleep exactly that.
 */
export async function takeLease({ acquire, alive, nodeId, ttlMs, now, sleep, stop = () => false }: { acquire: () => Promise<{ acquired: boolean; holder: Holder }>; alive: (nodeId: string) => Promise<boolean>; nodeId: string; ttlMs: number; now: () => number; sleep: (ms: number) => Promise<void>; stop?: () => boolean }): Promise<{ holder: Holder; acquiredAt: number } | undefined> {
  const giveUpAt = now() + ttlMs + ttlMs / 10;
  for (;;) {
    const acquiredAt = now();
    const taken = await acquire();
    if (taken.acquired) return { holder: taken.holder, acquiredAt };
    if (taken.holder.nodeId !== nodeId && (await alive(taken.holder.nodeId))) return undefined;
    if (now() >= giveUpAt) return undefined; // it did not expire when it should have: renewed after all
    // `stop`: the node is shutting down. Its close waits for every opening room, so waiting out a lease here would
    // outlast the forced exit, and the rooms already open would never be snapshotted or let go (noon-98h.1.1).
    if (stop()) return undefined;
    await sleep(ttlMs / 10);
    if (stop()) return undefined;
  }
}
