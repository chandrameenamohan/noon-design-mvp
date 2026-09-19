import type { Doc, Op } from "@noon/contracts";

/** mulberry32: a tiny seeded generator. Same seed, same sequence, on every machine: a failure can be replayed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPONENTS = ["Stack", "Card", "Button", "Text"];
const KEYS = ["gap", "label", "variant", "disabled"];
const VALUES = [8, 16, "primary", "Pay", true, false, null];

/**
 * One random op against `doc`. On purpose about a fifth of them are stale or nonsensical (an id
 * that was removed or never existed, a move into its own subtree, a wild index): that is what
 * concurrent editing looks like from the server's side.
 */
export function randomOp(random: () => number, doc: Doc): Op {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const ids = Object.keys(doc.nodes);
  const someId = (): string => (random() < 0.2 ? `ghost-${String(Math.floor(random() * 50))}` : pick(ids));
  const index = Math.floor(random() * 8) - 2;
  const roll = random();
  if (roll < 0.4) return { type: "add_node", nodeId: `n${String(Math.floor(random() * 120))}`, parentId: someId(), index, component: pick(COMPONENTS), props: {} };
  if (roll < 0.65) return { type: "move_node", nodeId: someId(), newParentId: someId(), index };
  if (roll < 0.8) return { type: "remove_node", nodeId: someId() };
  return { type: "set_prop", nodeId: someId(), key: pick(KEYS), value: pick(VALUES) };
}
