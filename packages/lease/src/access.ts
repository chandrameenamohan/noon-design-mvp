import { Redis } from "ioredis";
import { z } from "zod";

/**
 * E8.2 (F24): "this user's access to this org changed". A HINT, never the new role: every sync node reads the
 * role itself, from Postgres, so a forged or stale message can only cause a re-read, never grant anything.
 * Pub/sub delivers to whoever is subscribed at that moment and keeps nothing, so a subscriber that was
 * disconnected is told "all": it may have missed changes, and re-reads every live session's role.
 */
const AccessChange = z.strictObject({ orgId: z.uuid(), userId: z.uuid() });
type AccessChange = z.infer<typeof AccessChange>;

const channelOf = (prefix: string): string => `${prefix}access`;
const warn = (message: string): void => void process.stderr.write(`${JSON.stringify({ level: "warn", source: "access", message })}\n`);

/** The api's half. `publish` fails within `timeoutMs` when Redis is away, like every lease call. */
export function accessPublisher({ redisUrl, prefix = "", timeoutMs = 1000 }: { redisUrl: string; prefix?: string; timeoutMs?: number }): { publish(change: AccessChange): Promise<void>; close(): Promise<void> } {
  const redis = new Redis(redisUrl, { enableOfflineQueue: false, commandTimeout: timeoutMs, maxRetriesPerRequest: 1, connectTimeout: timeoutMs, lazyConnect: true });
  // Never log the error object: a failed AUTH carries the password in err.command.args.
  redis.on("error", (err: unknown) => { warn(err instanceof Error ? err.message || err.name : "unknown"); });
  const connecting = redis.connect().catch(() => undefined); // the first publish must not race the handshake
  return {
    async publish(change) {
      await connecting;
      await redis.publish(channelOf(prefix), JSON.stringify(AccessChange.parse(change)));
    },
    async close() {
      await connecting;
      await redis.quit().catch(() => { redis.disconnect(); });
    },
  };
}

/**
 * A sync node's half. `onChange` hears every change, and "all" each time the connection is (re)established, the
 * first time included. ioredis reconnects for ever and subscribes again by itself; with Redis away at startup the
 * SUBSCRIBE waits in its offline queue. `subscribed` resolves once Redis has it (tests wait for it).
 * ponytail: "all" fires as the connection is ready, as the SUBSCRIBE is sent, not once Redis confirmed it; ceiling:
 * a change published in that round trip, after the re-read began, is missed; upgrade: re-read on the subscribe reply.
 */
export function accessSubscriber({ redisUrl, prefix = "", onChange }: { redisUrl: string; prefix?: string; onChange: (change: AccessChange | "all") => void }): { subscribed: Promise<void>; close(): Promise<void> } {
  const redis = new Redis(redisUrl);
  redis.on("error", (err: unknown) => { warn(err instanceof Error ? err.message || err.name : "unknown"); });
  const channel = channelOf(prefix);
  redis.on("message", (from: string, text: string) => {
    if (from !== channel) return;
    let parsed;
    try {
      parsed = AccessChange.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) onChange(parsed.data);
    else warn("an access change that is not one was ignored");
  });
  redis.on("ready", () => { onChange("all"); });
  const subscribed = redis.subscribe(channel).then(() => undefined);
  subscribed.catch(() => undefined); // closed before it connected: nothing to report
  return {
    subscribed,
    async close() {
      await redis.quit().catch(() => { redis.disconnect(); });
    },
  };
}
