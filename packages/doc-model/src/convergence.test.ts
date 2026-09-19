import { expect, test } from "vitest";
import type { Doc, Op } from "@noon/contracts";
import { applyOp, checkDoc, emptyDoc, ROOT_ID } from "./index.ts";
import { randomOp, seeded } from "./random-ops.ts";

// The property the whole sync design rests on: the server puts ops in ONE order, and every peer
// that applies that order ends with the SAME document. That only holds if applyOp is total (any
// op, however stale or nonsensical, has a defined result) and deterministic.

test.each(Array.from({ length: 200 }, (_, seed) => seed))("seed %i: peers applying the same ops agree, and the tree stays well formed", (seed) => {
  const random = seeded(seed);
  const ops: Op[] = [];
  let reference: Doc = emptyDoc();
  for (let i = 0; i < 80; i++) {
    const op = randomOp(random, reference); // generated against the evolving doc, including stale and invalid ones
    ops.push(op);
    reference = applyOp(reference, op);
    expect(checkDoc(reference), `after op ${String(i)} ${JSON.stringify(op)}`).toEqual([]);
  }
  // A second peer that receives the ops over the wire (so: a JSON round trip) and applies them later.
  const overTheWire = JSON.parse(JSON.stringify(ops)) as Op[];
  const peer = overTheWire.reduce(applyOp, emptyDoc());
  expect(peer).toEqual(reference);
  expect(JSON.stringify(peer)).toBe(JSON.stringify(reference)); // same key order too: snapshots must be byte-stable
  expect(peer.nodes[ROOT_ID]).toBeDefined();
});

test("the generator really exercises every op type and the awkward cases", () => {
  const random = seeded(1);
  let doc = emptyDoc();
  const seen = new Set<string>();
  let noOps = 0;
  for (let i = 0; i < 2000; i++) {
    const op = randomOp(random, doc);
    seen.add(op.type);
    const next = applyOp(doc, op);
    if (next === doc) noOps++;
    doc = next;
  }
  expect([...seen].sort()).toEqual(["add_node", "move_node", "remove_node", "set_prop"]);
  expect(noOps).toBeGreaterThan(100); // stale and invalid ops are part of the mix, not avoided
  expect(noOps).toBeLessThan(1900);
});

// validate() is the policy and applyOp() the safety net. They must never disagree about structure:
// whatever validate refuses for a structural reason, applyOp must also leave untouched.
import type { Manifest } from "@noon/contracts";
import { validate } from "./index.ts";

const permissive: Manifest = {
  version: 1,
  components: ["Stack", "Card", "Button", "Text"].map((name) => ({
    name,
    acceptsChildren: true,
    props: [
      { name: "gap", type: { kind: "number" }, required: false },
      { name: "label", type: { kind: "string" }, required: false },
      { name: "variant", type: { kind: "string" }, required: false },
      { name: "disabled", type: { kind: "boolean" }, required: false },
    ],
  })),
};

test.each(Array.from({ length: 100 }, (_, seed) => seed + 1000))("seed %i: validate and applyOp agree about structure", (seed) => {
  const random = seeded(seed);
  let doc = emptyDoc();
  for (let i = 0; i < 80; i++) {
    const op = randomOp(random, doc);
    const verdict = validate(doc, op, permissive);
    const next = applyOp(doc, op);
    if (!verdict.ok && ["gone", "cycle", "duplicate_node", "root_is_fixed"].includes(verdict.reason)) {
      expect(next, `${verdict.reason}: ${JSON.stringify(op)}`).toBe(doc);
    }
    if (verdict.ok && op.type !== "set_prop") expect(next, `accepted but not applied: ${JSON.stringify(op)}`).not.toBe(doc);
    doc = next;
  }
});
