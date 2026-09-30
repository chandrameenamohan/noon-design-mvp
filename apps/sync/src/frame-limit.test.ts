import { expect, test } from "vitest";
import { ClientMessage, MAX_PROPS_BYTES } from "@noon/contracts";
import { MAX_FRAME_BYTES } from "./server.ts";

// noon-3m1: a contract must be at least as strict as the strictest system behind it. Behind an op is the
// socket's maxPayload, which counts UTF-8 bytes and closes the connection (1009) instead of answering. An op
// the contract accepts but the socket cannot carry is resent for ever. This ties the two limits together:
// changing either one so that they cross fails here.
const cjk = (n: number): string => "中".repeat(n); // 1 UTF-16 unit, 3 UTF-8 bytes
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

test("the fattest op frame the contract accepts still fits through the socket, in multi-byte characters", () => {
  // Every other field at its own maximum, in the widest characters it allows.
  const frame = (props: Record<string, string>) => ({
    type: "op",
    opId: "11111111-1111-4111-8111-111111111111",
    baseSeq: Number.MAX_SAFE_INTEGER,
    op: { type: "add_node", nodeId: "n".repeat(64), parentId: "p".repeat(64), index: -Number.MAX_SAFE_INTEGER, component: cjk(100), props },
  });
  const accepted = (props: Record<string, string>): boolean => ClientMessage.safeParse(frame(props)).success;

  // The largest bag: one value at its 10,000-character cap, a second grown until the contract refuses it.
  let n = 0;
  while (accepted({ a: cjk(10_000), b: cjk(n + 1) })) n++;
  const largest = { a: cjk(10_000), b: cjk(n) };
  expect(bytes(largest)).toBeLessThanOrEqual(MAX_PROPS_BYTES);
  expect(bytes(largest)).toBeGreaterThan(MAX_PROPS_BYTES - 3); // it really is the largest, not a bag the loop gave up on
  expect(bytes(frame(largest))).toBeLessThan(MAX_FRAME_BYTES);
});
