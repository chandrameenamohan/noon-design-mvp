import { expect, test } from "vitest";
import { ClientOp, Doc, PropValue, type Op } from "@noon/contracts";
import { applyOp, applyOpInto, checkDoc, emptyDoc, ROOT_ID } from "./index.ts";
import { randomOp, seeded } from "./random-ops.ts";

// Findings from the E2.2 verification and review, each reproduced here first.

const RESERVED = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];
const add = (nodeId: string, parentId: string): Op => ({ type: "add_node", nodeId, parentId, index: 0, component: "Stack", props: {} });

test.each(RESERVED)("a node id that names something on Object.prototype (%s) is refused by the contract", (name) => {
  const opId = "11111111-1111-4111-8111-111111111111";
  for (const op of [add(name, ROOT_ID), add("x", name), { type: "set_prop", nodeId: name, key: "gap", value: 1 }, { type: "set_prop", nodeId: "x", key: name, value: 1 }, { type: "add_node", nodeId: "x", parentId: ROOT_ID, index: 0, component: "Stack", props: { [name]: 1 } }]) {
    expect(ClientOp.safeParse({ opId, baseSeq: 0, op }).success, JSON.stringify(op)).toBe(false);
  }
});

test.each(RESERVED)("applyOp is still TOTAL if such an op reaches it anyway (%s): no throw, no corruption", (name) => {
  const doc = applyOp(emptyDoc(), add("a", ROOT_ID));
  for (const op of [add("x", name), add(name, ROOT_ID), { type: "move_node", nodeId: "a", newParentId: name, index: 0 }, { type: "move_node", nodeId: name, newParentId: ROOT_ID, index: 0 }, { type: "remove_node", nodeId: name }, { type: "set_prop", nodeId: name, key: "gap", value: 8 }, { type: "set_prop", nodeId: "a", key: name, value: 8 }] satisfies Op[]) {
    const next = applyOp(doc, op);
    expect(checkDoc(next), JSON.stringify(op)).toEqual([]);
    expect(Object.keys(next.nodes).every((id) => id === next.nodes[id]?.id), JSON.stringify(op)).toBe(true);
  }
  expect(Object.keys(Object.prototype)).toEqual([]); // and nothing leaked onto the prototype
});

test("content-preserving ops return the SAME object", () => {
  const doc = [add("a", ROOT_ID), add("b", ROOT_ID)].reduce(applyOp, emptyDoc()); // children: [b, a]
  expect(applyOp(doc, { type: "move_node", nodeId: "b", newParentId: ROOT_ID, index: 0 })).toBe(doc); // already there
  expect(applyOp(doc, { type: "set_prop", nodeId: "a", key: "gap", value: null })).toBe(doc); // never set
  const set = applyOp(doc, { type: "set_prop", nodeId: "a", key: "gap", value: 8 });
  expect(applyOp(set, { type: "set_prop", nodeId: "a", key: "gap", value: 8 })).toBe(set); // same value
});

test("prop values: no control characters (Postgres jsonb cannot store NUL) and no negative zero", () => {
  expect(PropValue.safeParse(`a${String.fromCharCode(0)}b`).success).toBe(false);
  expect(PropValue.safeParse(`a${String.fromCharCode(27)}b`).success).toBe(false);
  expect(PropValue.safeParse("tabs\tand\nnewlines are fine in text").success).toBe(true);
  // -0 survives locally but JSON writes it as 0, so the sender and everyone else would disagree.
  expect(PropValue.safeParse(-0).success).toBe(false);
  expect(PropValue.safeParse(0).success).toBe(true);
});

test("an op cannot carry an unbounded bag of props", () => {
  const opId = "11111111-1111-4111-8111-111111111111";
  const props = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${String(i)}`, i]));
  const op = (p: Record<string, number>) => ({ opId, baseSeq: 0, op: { type: "add_node", nodeId: "x", parentId: ROOT_ID, index: 0, component: "Stack", props: p } });
  expect(ClientOp.safeParse(op(props(50))).success).toBe(true);
  expect(ClientOp.safeParse(op(props(51))).success).toBe(false);
  expect(ClientOp.safeParse(op({ ["k".repeat(101)]: 1 })).success).toBe(false);
});

test("checkDoc DIAGNOSES a broken document instead of crashing on it", () => {
  const node = (id: string, parentId: string | null, children: string[]) => ({ id, component: "Stack", props: {}, parentId, children });
  const cyclic = { rootId: "root", nodes: { root: node("root", null, ["a"]), a: node("a", "root", ["b"]), b: node("b", "a", ["a"]) } };
  expect(checkDoc(cyclic).join("; ")).toMatch(/reachable twice/);
  expect(checkDoc({ rootId: "root", nodes: {} })).toEqual(["root root is missing"]);
  expect(checkDoc({ rootId: "root", nodes: { root: node("root", null, ["ghost"]) } }).join("; ")).toMatch(/ghost/);
  expect(checkDoc({ rootId: "root", nodes: { root: node("root", null, []), lost: node("lost", "root", []) } }).join("; ")).toMatch(/lost: not reachable/);
  expect(checkDoc({ rootId: "root", nodes: { root: node("root", null, ["a"]), a: node("WRONG", "root", []) } }).join("; ")).toMatch(/wrong key/);
  // A node loaded from outside that skipped the contract: no children, no props, not even an object.
  const mangled = { rootId: "root", nodes: { root: { id: "root", component: "Page", props: {}, parentId: null }, junk: null, other: "text" } } as unknown as Parameters<typeof checkDoc>[0];
  expect(() => checkDoc(mangled)).not.toThrow();
  expect(checkDoc(mangled).join("; ")).toMatch(/root: not a well-formed node/);
});

test.each(Array.from({ length: 60 }, (_, seed) => seed + 5000))("seed %i: re-applying an op changes nothing, and the document survives a JSON + contract round trip", (seed) => {
  const random = seeded(seed);
  let doc = emptyDoc();
  for (let i = 0; i < 60; i++) {
    const op = randomOp(random, doc);
    const once = applyOp(doc, op);
    // Idempotence: a resend after a reconnect, or a journal row replayed twice, must be harmless.
    expect(applyOp(once, op), `idempotence: ${JSON.stringify(op)}`).toEqual(once);
    // What a snapshot does: serialise, parse, validate. Nothing may be lost or altered on the way.
    expect(Doc.parse(JSON.parse(JSON.stringify(once))), `round trip after ${JSON.stringify(op)}`).toEqual(once);
    doc = once;
  }
});

test.each(Array.from({ length: 60 }, (_, seed) => seed + 7000))("seed %i: the in-place applier and the pure applier always agree", (seed) => {
  const random = seeded(seed);
  let pure = emptyDoc();
  const mutable = emptyDoc();
  for (let i = 0; i < 80; i++) {
    const op = randomOp(random, pure);
    const next = applyOp(pure, op);
    expect(applyOpInto(mutable, op), JSON.stringify(op)).toBe(next !== pure); // reports whether anything changed
    pure = next;
    expect(mutable).toEqual(pure);
  }
  expect(JSON.stringify(mutable)).toBe(JSON.stringify(pure));
});

test("replaying 10,000 ops into a large document fits the recovery budget (F19 allows 2 s in total)", () => {
  const doc = emptyDoc();
  const started = performance.now();
  for (let i = 0; i < 5000; i++) applyOpInto(doc, add(`n${String(i)}`, i === 0 ? ROOT_ID : `n${String(Math.floor(i / 2))}`));
  for (let i = 0; i < 5000; i++) applyOpInto(doc, { type: "set_prop", nodeId: `n${String(i)}`, key: "gap", value: i });
  const elapsed = performance.now() - started;
  expect(Object.keys(doc.nodes)).toHaveLength(5001);
  expect(checkDoc(doc)).toEqual([]);
  expect(elapsed, `${elapsed.toFixed(0)} ms`).toBeLessThan(500); // the copying applier took 13,000-26,000 ms here
});
