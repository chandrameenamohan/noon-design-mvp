import { z } from "zod";

/**
 * E9.5 (F31): a rate limit is `limit` hits per key in each fixed window of `windowSeconds`, counted in Postgres (the
 * rate_limits table, migration 0020) so every api instance shares one count. Reused by E9.6 (per user, per address,
 * session minting) through `Db.take`. ponytail: fixed windows, so a key may spend `limit` at the end of one window and
 * `limit` again at the start of the next (twice the rate for a moment); upgrade: a sliding window (two counters,
 * weighted) if that burst ever matters.
 */
export const Rule = z.strictObject({ limit: z.number().int().min(1), windowSeconds: z.number().int().min(1).max(86_400) });
export type Rule = z.infer<typeof Rule>;
export type Verdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * `hits`: this key's count in `window` (the window's index since the epoch), this hit included; `now`: the DATABASE's
 * clock in seconds, so api instances whose clocks disagree still give one answer. Over the limit, the wait is until the
 * window ends, rounded up (a client that waits exactly that long is let in), and never under one second.
 */
export function verdict({ hits, window, now }: { hits: number; window: number; now: number }, rule: Rule): Verdict {
  if (hits <= rule.limit) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window + 1) * rule.windowSeconds - now)) };
}
