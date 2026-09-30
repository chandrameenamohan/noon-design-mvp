import { expect, test, vi } from "vitest";
import { Fenced } from "@noon/db";
import { watchFence } from "./fence.ts";

test("a fenced append is still refused to the room, and says so to the server exactly once", async () => {
  const onFenced = vi.fn();
  const append = watchFence((seq: number) => (seq > 1 ? Promise.reject(new Fenced("fenced")) : Promise.resolve(undefined)), onFenced);
  await expect(append(1)).resolves.toBeUndefined();
  expect(onFenced).not.toHaveBeenCalled();
  await expect(append(2)).rejects.toBeInstanceOf(Fenced);
  await expect(append(3)).rejects.toBeInstanceOf(Fenced); // a queued op refused after it: not a second drop
  expect(onFenced).toHaveBeenCalledTimes(1);
});

test("an outage is not a fence: the room goes read-only and the server keeps the room", async () => {
  const onFenced = vi.fn();
  const append = watchFence(() => Promise.reject(new Error("journal timed out")), onFenced);
  await expect(append()).rejects.toThrow("timed out");
  expect(onFenced).not.toHaveBeenCalled();
});
