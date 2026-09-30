import { expect, test, vi } from "vitest";
import { reportSlow } from "./slow.ts";

test("a journal call slower than the threshold is reported with how long it took; a quick one is not", async () => {
  let clock = 0;
  const report = vi.fn();
  const timed = reportSlow(250, report, () => clock);
  const quick = timed("append", Promise.resolve(1));
  clock = 249;
  await expect(quick).resolves.toBe(1);
  expect(report).not.toHaveBeenCalled();

  clock = 0;
  let finish = (): void => undefined;
  const slow = timed("everAdded", new Promise<string>((resolve) => { finish = () => { resolve("done"); }; }));
  clock = 3072;
  finish();
  await expect(slow).resolves.toBe("done");
  expect(report).toHaveBeenCalledWith("everAdded", 3072);
});

test("a slow FAILURE is reported too, and still reaches the caller: a timed-out append is the stall worth knowing about", async () => {
  let clock = 0;
  const report = vi.fn();
  const failing = reportSlow(250, report, () => clock)("append", Promise.reject(new Error("journal timed out")).finally(() => { clock = 5000; }));
  await expect(failing).rejects.toThrow("timed out");
  expect(report).toHaveBeenCalledWith("append", 5000);
});
