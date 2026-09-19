import type { ClientOp, Doc, Op, SequencedOp, ServerMessage } from "@noon/contracts";
import { manifest } from "@noon/design-system";
import { applyOp, checkDoc, emptyDoc } from "@noon/doc-model";
import { randomOp, seeded } from "@noon/doc-model/random-ops";
import { createReplica, type DocMessage } from "@noon/peer-client";
import { createRoom, type Peer } from "./room.ts";

/**
 * The reconcile simulator (SPEC F8a). It drives the REAL room and the REAL replica, several peers at
 * once, with a network that delays, reorders and drops, and a server that restarts. Everything that
 * could differ between two runs is taken from ONE seeded generator: which event happens next, the
 * ops, the op ids, the peer ids, the clock. Same seed, same run, byte for byte: a failure found
 * once can be replayed for ever, on any machine.
 *
 * What is NOT simulated: sockets, Postgres, timers. Those are tested against the real things.
 */
type Factories = { createRoom: typeof createRoom; createReplica: typeof createReplica };
type Options = { seed: number; steps?: number; peers?: number; factories?: Partial<Factories> };
export type SimResult = { ok: boolean; seed: number; steps: number; failure?: string; trace: string[] };

const short = (id: string): string => id.slice(-4);
/** One spelling per document: two peers hold the same nodes but inserted them in different orders. */
const canon = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const describe = (op: Op): string =>
  op.type === "add_node" ? `add ${op.nodeId} in ${op.parentId}@${String(op.index)}` : op.type === "move_node" ? `move ${op.nodeId} to ${op.newParentId}@${String(op.index)}` : op.type === "remove_node" ? `remove ${op.nodeId}` : `set ${op.nodeId}.${op.key}=${String(op.value)}`;

/**
 * Edits that COLLIDE. randomOp spreads over 120 ids and four prop names, so two peers almost never
 * touch the same prop of the same node; here there are six nodes, all containers, one numeric prop
 * each. Found by mutation: with randomOp alone, a replica that re-applied a late acknowledgement
 * (overwriting a newer value) passed every seed.
 */
function conflictOp(random: () => number, doc: Doc): Op {
  const id = (): string => `k${String(Math.floor(random() * 6))}`;
  const roll = random();
  const nodeId = id();
  const node = Object.hasOwn(doc.nodes, nodeId) ? doc.nodes[nodeId] : undefined;
  if (!node || roll < 0.15) return { type: "add_node", nodeId, parentId: random() < 0.5 ? "root" : id(), index: Math.floor(random() * 3), component: random() < 0.5 ? "Stack" : "Card", props: {} };
  if (roll < 0.7) return { type: "set_prop", nodeId, key: node.component === "Stack" ? "gap" : "padding", value: Math.floor(random() * 4) };
  if (roll < 0.92) return { type: "move_node", nodeId, newParentId: random() < 0.4 ? "root" : id(), index: Math.floor(random() * 3) };
  return { type: "remove_node", nodeId };
}

export async function runSim({ seed, steps = 300, peers: peerCount = 3, factories = {} }: Options): Promise<SimResult> {
  const make: Factories = { createRoom, createReplica, ...factories };
  const random = seeded(seed);
  const chance = (p: number): boolean => random() < p;
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join("");
  const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`; // the shape the contract asks for, from OUR generator
  const trace: string[] = [];
  let step = 0;

  // The independent record of what the room decided: every sequenced op, by seq and by opId.
  const firstSeq = 1;
  const log: SequencedOp[] = [];
  // A client's own edits must reach the room in the order it made them (red, then blue).
  const madeAt = new Map<string, number>();
  const inOrder = (client: { name: string }, frames: ClientOp[]): ClientOp[] => {
    frames.reduce((last, frame) => { const at = madeAt.get(frame.opId) ?? -1; if (at < last) fail(`${client.name} sent ${short(frame.opId)} AFTER an op it made later`); return at; }, -1);
    return frames;
  };
  const seqOf = new Map<string, number>();
  // Last writer wins, from FIRST PRINCIPLES: per node, the value of each prop is the one in the
  // highest-seq op that wrote it. Kept apart from doc-model on purpose: the "replay the log" check
  // below uses doc-model's own applier, so a wrong rule inside it would agree with itself.
  const lastWritten = new Map<string, Map<string, unknown>>();
  let failure: string | undefined;
  const fail = (why: string): void => { failure ??= `step ${String(step)}: ${why}`; };

  // No real clock: time is the step counter, and the budget is out of the way (rate-limit.int.test.ts owns it).
  const roomOptions = { manifest, now: () => step * 10, mintPeerId: uuid, rate: { perSecond: 1e9, burst: 1e9 } };
  let room = make.createRoom({ doc: emptyDoc(), ...roomOptions });

  /** One simulated client: a real replica, and the two directions of its connection as FIFO queues. */
  type Client = { name: string; replica: ReturnType<typeof createReplica>; peer: Peer | undefined; toServer: ClientOp[]; toClient: ServerMessage[] };
  const clients: Client[] = Array.from({ length: peerCount }, (_, i) => ({ name: `c${String(i)}`, replica: make.createReplica({ manifest, mintOpId: uuid }), peer: undefined, toServer: [], toClient: [] }));

  function connect(client: Client): void {
    const peer: Peer = {
      actor: { kind: "user", id: client.name },
      session: { userId: client.name, orgId: "org", expiresAt: 0 },
      // A message belongs to the room until it is on the wire: copy it, as JSON.stringify would.
      send: (message) => {
        record(message); // as the room SAYS it, not when a client hears it: the room's document is already ahead
        if (client.peer === peer) client.toClient.push(structuredClone(message));
      },
    };
    client.peer = peer;
    client.toServer = [];
    client.toClient = [];
    room.join(peer); // queues the welcome
  }
  /** The connection dies: whatever was in flight, in either direction, is gone. */
  function disconnect(client: Client): void {
    if (client.peer) room.leave(client.peer);
    client.peer = undefined;
    client.toServer = [];
    client.toClient = [];
  }

  function record(message: ServerMessage): void {
    if (message.type !== "op" || log.some((each) => each.seq === message.seq)) return;
    const before = seqOf.get(message.opId);
    if (before !== undefined) fail(`op ${short(message.opId)} was applied TWICE: at seq ${String(before)} and again at seq ${String(message.seq)}`);
    if (message.seq !== (log.at(-1)?.seq ?? firstSeq - 1) + 1) fail(`seq ${String(message.seq)} does not follow seq ${String(log.at(-1)?.seq ?? firstSeq - 1)}: a number was skipped or repeated`);
    seqOf.set(message.opId, message.seq);
    log.push({ seq: message.seq, opId: message.opId, actor: message.actor, op: message.op });
    // Every op in the log CHANGED something (one that would not is answered with "ack" and gets no seq),
    // and the room emits them in seq order, so this is simply "the latest write".
    const { op } = message;
    // "index is the node's FINAL position" (SPEC 2.4), from first principles: the room has already
    // applied the op when it announces it, so look where the node actually is.
    const parent = op.type === "add_node" ? room.doc.nodes[op.parentId] : op.type === "move_node" ? room.doc.nodes[op.newParentId] : undefined;
    if (parent && (op.type === "add_node" || op.type === "move_node")) {
      const wanted = Math.min(Math.max(op.index, 0), parent.children.length - 1);
      if (parent.children.indexOf(op.nodeId) !== wanted) fail(`${op.nodeId} should be child ${String(wanted)} of ${parent.id}, it is child ${String(parent.children.indexOf(op.nodeId))}`);
    }
    if (op.type === "add_node") lastWritten.set(op.nodeId, new Map(Object.entries(op.props)));
    else if (op.type === "set_prop" && op.value === null) lastWritten.get(op.nodeId)?.delete(op.key);
    else if (op.type === "set_prop") lastWritten.get(op.nodeId)?.set(op.key, op.value);
  }

  function check(): void {
    for (const problem of checkDoc(room.doc)) fail(`the room's document is malformed: ${problem}`);
    for (const client of clients) for (const problem of checkDoc(client.replica.doc)) fail(`${client.name}'s document is malformed: ${problem}`);
    // A replica that has heard everything and waits for nothing must hold the room's document NOW, not
    // only at the end: later edits overwrite a wrong value and would hide the divergence by then.
    const roomNow = canon(room.doc);
    for (const client of clients) {
      const caughtUp = client.peer !== undefined && client.toClient.length === 0 && client.replica.pendingCount === 0 && client.replica.seq === room.seq;
      if (caughtUp && canon(client.replica.doc) !== roomNow) fail(`${client.name} has heard everything up to seq ${String(room.seq)} and still holds a different document`);
    }
    for (const node of Object.values(room.doc.nodes)) {
      const expected = canon(Object.fromEntries(lastWritten.get(node.id) ?? []));
      if (node.parentId !== null && canon(node.props) !== expected) fail(`last writer did not win on ${node.id}: the room holds ${canon(node.props)}, the latest writes say ${expected}`);
    }
    // The rest of the rules (a remove beats an edit, index = final position) in one check: the room's
    // document is exactly what applying the sequenced ops in seq order produces, recomputed with the
    // PURE applier (the room uses the in-place one): it catches a room that skips, repeats or reorders.
    const model = [...log].sort((a, b) => a.seq - b.seq).reduce<Doc>((doc, each) => applyOp(doc, each.op), emptyDoc());
    if (canon(model) !== canon(room.doc)) fail("the room's document is not what its own sequence of ops produces");
  }

  async function deliverToServer(client: Client): Promise<void> {
    const frame = client.toServer.shift();
    if (!frame || !client.peer) return;
    trace.push(`${client.name} -> room  ${short(frame.opId)} base ${String(frame.baseSeq)}: ${describe(frame.op)}`);
    await room.submit(client.peer, frame); // the room's queue is async: not awaiting it would run nothing
  }
  function deliverToClient(client: Client): void {
    const message = client.toClient.shift();
    if (!message || message.type === "presence" || message.type === "presence_left") return;
    trace.push(`room -> ${client.name}  ${message.type}${message.type === "op" ? ` seq ${String(message.seq)} ${short(message.opId)}` : message.type === "rejected" ? ` ${short(message.opId)} ${message.reason}` : message.type === "welcome" ? ` seq ${String(message.seq)}` : ` ${short(message.opId)}`}`);
    const effects = client.replica.receive(message satisfies DocMessage);
    for (const rejection of effects.rejected) trace.push(`${client.name} gives up ${short(rejection.opId)}: ${rejection.reason}`);
    if (effects.resync || effects.fatal) { disconnect(client); connect(client); }
    client.toServer.push(...inOrder(client, client.replica.takeSendable()));
  }

  for (const client of clients) connect(client);
  for (step = 1; step <= steps && !failure; step++) {
    const client = clients[Math.floor(random() * clients.length)] as Client;
    const roll = random();
    if (roll < 0.35) {
      const op = chance(0.6) ? conflictOp(random, client.replica.doc) : randomOp(random, client.replica.doc);
      const result = client.replica.local(op);
      if (result.ok) madeAt.set(result.opId, madeAt.size);
      trace.push(`${client.name} edits  ${describe(op)}${result.ok ? "" : ` (refused locally: ${result.reason})`}`);
      if (client.peer) client.toServer.push(...inOrder(client, client.replica.takeSendable()));
    } else if (roll < 0.65) await deliverToServer(client);
    else if (roll < 0.95) deliverToClient(client);
    else if (roll < 0.99) {
      trace.push(`${client.name} loses its connection${chance(0.5) ? " and returns" : ""}`);
      disconnect(client);
      if (trace.at(-1)?.endsWith("returns")) connect(client);
    } else {
      // The sync server restarts: the document survives (it was saved), the room's memory does not.
      trace.push(`the room is reloaded at seq ${String(room.seq)}`);
      for (const each of clients) disconnect(each);
      room = make.createRoom({ doc: structuredClone(room.doc), seq: room.seq, ...roomOptions });
    }
    check();
  }

  // Quiet at last: everyone reconnects, every queue drains. Bounded, so a livelock is a failure, not a hang.
  for (const client of clients) if (!client.peer) connect(client);
  for (let round = 0; round < 10_000 && !failure && clients.some((c) => c.toServer.length + c.toClient.length + c.replica.pendingCount > 0); round++) {
    for (const client of clients) { await deliverToServer(client); deliverToClient(client); }
    check();
  }
  for (const client of clients) {
    if (client.replica.pendingCount > 0) fail(`${client.name} still has ${String(client.replica.pendingCount)} unanswered ops after the network went quiet`);
    else if (canon(client.replica.doc) !== canon(room.doc)) fail(`${client.name} did not converge on the room's document`);
  }
  return { ok: failure === undefined, seed, steps, ...(failure === undefined ? {} : { failure }), trace };
}

/** The shortest prefix of the run that still fails: what a person should read first. */
export async function shrink(options: Options & { steps: number }): Promise<SimResult> {
  let best = await runSim(options);
  if (best.ok) return best;
  for (let steps = 1; steps < options.steps; steps++) {
    const attempt = await runSim({ ...options, steps });
    if (!attempt.ok) { best = attempt; break; }
  }
  return best;
}
