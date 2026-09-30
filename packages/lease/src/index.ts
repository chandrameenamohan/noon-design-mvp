import { Redis } from "ioredis";
import { formatHolder, parseHolder, type Holder } from "./lease.ts";

export { keepLease, NodeId, syncNodesField, syncRouter, takeLease, type Holder, type SyncNodes } from "./lease.ts";

/**
 * Room leases in Redis (SPEC §2a): who owns each document's room, for how long, under which fencing token.
 * Keys: `<prefix>lease:<documentId>` holds "<token>:<nodeId>" with a PX expiry; `<prefix>lease-token:<documentId>`
 * is the document's token counter, never expiring, so a later owner always gets a larger token.
 * `<prefix>node:<nodeId>` is a sync node's heartbeat (E7.2): it expires a third of a ttl after the node's last
 * beat, so a killed owner is known dead long before its leases expire. Routing reads it; nothing safe does.
 * The counter lives in Redis, so a flushed Redis would start the tokens again at 1: an acquire therefore takes a
 * `floor` (the largest token the journal's fence has seen, E7.3) and never issues a token at or below it.
 */
export type Leases = {
  /** How long a lease lives without renewal. The holder renews every third of it. */
  readonly ttlMs: number;
  /**
   * Take the room if nobody holds it, under a token above `floor`. Answers the holder either way: compare its
   * nodeId (and token) with yours.
   */
  acquire(documentId: string, nodeId: string, floor?: number): Promise<{ acquired: boolean; holder: Holder }>;
  /** Extend, only if `holder` is still exactly the lease's value. False: it expired or is someone else's. */
  renew(documentId: string, holder: Holder): Promise<boolean>;
  /** Let go, only if still ours: a late release must never delete the NEXT owner's lease. */
  release(documentId: string, holder: Holder): Promise<void>;
  owner(documentId: string): Promise<Holder | undefined>;
  /** "This node is alive" for a third of a ttl. A sync node calls it every tenth of one. */
  beat(nodeId: string): Promise<void>;
  /** Which of these nodes beat recently. */
  alive(nodeIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Resolves once Redis answered a PING; rejects after `timeoutMs`. */
  ready(): Promise<void>;
  close(): Promise<void>;
};

// One script, so nothing can happen between "nobody holds it", the token and the SET. The token is issued
// only when the SET happens: N racing acquirers of a free room move the counter by exactly one.
const ACQUIRE = `
local current = redis.call('GET', KEYS[1])
if current then return {0, current} end
if tonumber(redis.call('GET', KEYS[2]) or '0') < tonumber(ARGV[3]) then redis.call('SET', KEYS[2], ARGV[3]) end
local holder = redis.call('INCR', KEYS[2]) .. ':' .. ARGV[1]
redis.call('SET', KEYS[1], holder, 'PX', ARGV[2])
return {1, holder}`;
// Compare-and-extend and compare-and-delete: a plain PEXPIRE or DEL would touch a lease that expired and was
// taken by another node in the meantime (reproduced in learning-tests/redis, finding 2).
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export function createLeases({ redisUrl, ttlMs = 10_000, prefix = "", timeoutMs = 1000 }: { redisUrl: string; ttlMs?: number; prefix?: string; timeoutMs?: number }): Leases {
  // Every call must FAIL within a deadline when Redis is away (E3.1 lesson 1): no offline queue, a command
  // timeout, one retry. A caller that cannot ask refuses to open the room; it never guesses.
  const redis = new Redis(redisUrl, { enableOfflineQueue: false, commandTimeout: timeoutMs, maxRetriesPerRequest: 1, connectTimeout: timeoutMs });
  // Never log the error object: a failed AUTH carries the password in err.command.args.
  redis.on("error", (err: unknown) => process.stderr.write(`${JSON.stringify({ level: "warn", source: "lease", message: err instanceof Error ? err.message || err.name : "unknown" })}\n`));
  const leaseKey = (documentId: string): string => `${prefix}lease:${documentId}`;
  const ready = (): Promise<void> => new Promise((resolve, reject) => {
    if (redis.status === "ready") { resolve(); return; }
    const timer = setTimeout(() => { reject(new Error(`redis did not answer within ${String(timeoutMs)} ms`)); }, timeoutMs);
    redis.once("ready", () => { clearTimeout(timer); resolve(); });
  });
  return {
    ttlMs,
    async acquire(documentId, nodeId, floor = 0) {
      const [taken, value] = (await redis.eval(ACQUIRE, 2, leaseKey(documentId), `${prefix}lease-token:${documentId}`, nodeId, String(ttlMs), String(floor))) as [number, string];
      const holder = parseHolder(value);
      if (!holder) throw new Error(`lease of ${documentId} holds a value that is not a holder`);
      return { acquired: taken === 1, holder };
    },
    renew: async (documentId, holder) => (await redis.eval(RENEW, 1, leaseKey(documentId), formatHolder(holder), String(ttlMs))) === 1,
    async release(documentId, holder) {
      await redis.eval(RELEASE, 1, leaseKey(documentId), formatHolder(holder));
    },
    async owner(documentId) {
      const value = await redis.get(leaseKey(documentId));
      return value === null ? undefined : parseHolder(value);
    },
    async beat(nodeId) {
      await redis.set(`${prefix}node:${nodeId}`, "1", "PX", Math.max(1, Math.round(ttlMs / 3)));
    },
    async alive(nodeIds) {
      if (nodeIds.length === 0) return new Set();
      const beats = await redis.mget(...nodeIds.map((id) => `${prefix}node:${id}`));
      return new Set(nodeIds.filter((_, i) => beats[i] !== null));
    },
    async ready() {
      await ready();
      await redis.ping();
    },
    async close() {
      // Closing mid-handshake can reject a promise nobody holds (E3.1 lesson 2): let it finish, bounded.
      await ready().catch(() => undefined);
      await redis.quit().catch(() => { redis.disconnect(); });
    },
  };
}
