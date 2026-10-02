import { expect, test } from "vitest";
import { Rule, verdict } from "./limit.ts";

const hourly = { limit: 3, windowSeconds: 3600 };

test("up to the limit goes ahead; the next one waits for the window to end, to the second", () => {
  const window = 480_000 * 3600; // the window's first second since the epoch
  expect(verdict({ hits: 1, window, now: window }, hourly)).toEqual({ ok: true });
  expect(verdict({ hits: 3, window, now: window + 10 }, hourly)).toEqual({ ok: true });
  expect(verdict({ hits: 4, window, now: window + 10 }, hourly)).toEqual({ ok: false, retryAfterSeconds: 3590 });
  expect(verdict({ hits: 4, window, now: window + 3599.2 }, hourly)).toEqual({ ok: false, retryAfterSeconds: 1 }); // rounded UP: never "retry now" too early
  expect(verdict({ hits: 4, window, now: window }, hourly)).toEqual({ ok: false, retryAfterSeconds: 3600 });
});

test("never less than one second, even when the clock has already crossed into the next window", () => {
  expect(verdict({ hits: 9, window: 10 * 3600, now: 11 * 3600 + 0.5 }, hourly)).toEqual({ ok: false, retryAfterSeconds: 1 });
});

test("noon-elo.5.1: a count begun under a shorter window waits only until the next window of the rule in force", () => {
  // Counted from 3:00 under an hourly rule, now under a two-hour one: the row resets at 4:00 (the first two-hour
  // window to start after 3:00), not at 5:00, and never "for good".
  const twoHourly = { limit: 3, windowSeconds: 7200 };
  const threeOClock = 480_001 * 3600;
  expect(verdict({ hits: 4, window: threeOClock, now: threeOClock + 600 }, twoHourly)).toEqual({ ok: false, retryAfterSeconds: 3000 });
});

test("a rule is whole, positive numbers, and a window of at most a day", () => {
  expect(Rule.parse({ limit: 60, windowSeconds: 3600 })).toEqual({ limit: 60, windowSeconds: 3600 });
  for (const bad of [{ limit: 0, windowSeconds: 60 }, { limit: 1.5, windowSeconds: 60 }, { limit: 1, windowSeconds: 0 }, { limit: 1, windowSeconds: 86_401 }, { limit: 1 }]) {
    expect(Rule.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  }
});
